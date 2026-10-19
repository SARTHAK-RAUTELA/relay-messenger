import { test, expect, type Page } from "@playwright/test";
import { actor, blur, focus, openApp, openChat, readUpTo, seed, send } from "./helpers";

test("AC-22/AC-23: messages are read only while the window is focused; the sender sees read", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  const first = await send(ben, ada, "are you there?");
  await openApp(ada);
  await openApp(ben);
  await openChat(ben, ada);
  // Ada sends; Ben's open, focused view reads it (AC-22).
  const reads: string[] = [];
  ben.page.on("request", (r) => r.url().endsWith("/read") && reads.push(r.url()));
  await openChat(ada, ben);
  await expect(ada.page.getByTestId(`msg-${first}`).locator("[data-status]")).toHaveCount(0); // incoming: no status (AC-27)
  await ada.page.getByRole("textbox").fill("yes, here");
  await ada.page.getByRole("textbox").press("Enter");
  const mine = ada.page.locator(".bubble-row.out").last();
  await expect(mine.locator("[data-status='read']")).toBeVisible({ timeout: 10_000 });
  await expect(ada.page.getByTestId(`dialog-${ben.id}`).locator("[data-status='read']")).toBeVisible();

  // AC-23: Ben's window loses focus; a new message scrolls into view but is not read.
  await blur(ben.page);
  const before = reads.length;
  await ada.page.getByRole("textbox").fill("one more thing");
  await ada.page.getByRole("textbox").press("Enter");
  await expect(ben.page.getByTestId("message-list").getByText("one more thing")).toBeInViewport();
  await ben.page.waitForTimeout(1200);
  expect(reads.length).toBe(before);
  await expect(ada.page.locator(".bubble-row.out").last().locator("[data-status='sent']")).toBeVisible();
  await focus(ben.page);
  await expect(ada.page.locator(".bubble-row.out").last().locator("[data-status='read']")).toBeVisible({ timeout: 10_000 });
  expect(reads.length).toBeGreaterThan(before);
  await ada.ctx.close();
  await ben.ctx.close();
});

test("AC-30: pinned conversations can be reordered by drag; the order persists and syncs", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const p1 = await actor(browser, "Pia");
  const p2 = await actor(browser, "Quin");
  await send(p1, ada, "hi from Pia");
  await send(p2, ada, "hi from Quin");
  await openApp(ada);
  const second = await ada.ctx.newPage(); // A's other session
  await second.goto("/");
  for (const p of [p1, p2]) {
    const row = ada.page.getByTestId(`dialog-${p.id}`);
    await row.getByLabel("Conversation options").click();
    await row.getByRole("menuitem", { name: "Pin to top" }).click();
  }
  const order = (pg: Page) => pg.locator(".dialog-list .row").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  await expect.poll(() => order(ada.page)).toEqual([`dialog-${p2.id}`, `dialog-${p1.id}`]); // newest pin on top
  await ada.page.getByTestId(`dialog-${p1.id}`).dragTo(ada.page.getByTestId(`dialog-${p2.id}`));
  await expect.poll(() => order(ada.page)).toEqual([`dialog-${p1.id}`, `dialog-${p2.id}`]);
  await expect.poll(() => order(second)).toEqual([`dialog-${p1.id}`, `dialog-${p2.id}`]);
  await ada.page.reload();
  await expect.poll(() => order(ada.page)).toEqual([`dialog-${p1.id}`, `dialog-${p2.id}`]);
  await ada.ctx.close();
  await p1.ctx.close();
  await p2.ctx.close();
});

test("AC-38: loading older messages keeps the visible message in place (no scroll jump)", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  const ids = await seed(ben, ada, 120);
  await readUpTo(ada, ben, ids[ids.length - 1]);
  await openApp(ada);
  await openChat(ada, ben);
  const list = ada.page.getByTestId("message-list");
  await expect(ada.page.getByTestId(`msg-${ids[119]}`)).toBeInViewport();
  const firstLoaded = Number(await list.locator("[data-mid]").first().getAttribute("data-mid"));
  expect(firstLoaded).toBeGreaterThan(ids[0]);
  // Scroll so the oldest loaded message sits a bit below the top, then into the paging zone.
  const anchor = ada.page.getByTestId(`msg-${firstLoaded}`);
  await list.evaluate((el) => (el.scrollTop = 150));
  const y0 = (await anchor.boundingBox())!.y;
  await expect(list.locator(`[data-mid='${firstLoaded - 1}']`)).toHaveCount(1, { timeout: 10_000 }); // older page arrived
  await ada.page.waitForTimeout(300);
  const y1 = (await anchor.boundingBox())!.y;
  expect(Math.abs(y1 - y0)).toBeLessThan(30);
  // Keep scrolling up until the very first message is loaded.
  for (let i = 0; i < 10 && (await list.locator(`[data-mid='${ids[0]}']`).count()) === 0; i++) {
    await list.evaluate((el) => (el.scrollTop = 0));
    await ada.page.waitForTimeout(400);
  }
  await expect(list.locator(`[data-mid='${ids[0]}']`)).toHaveCount(1);
  await ada.ctx.close();
  await ben.ctx.close();
});

test("AC-39: with 10 unread the view opens at the first unread message with the divider above it", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  const ids = await seed(ben, ada, 60);
  await readUpTo(ada, ben, ids[49]);
  await blur(ada.page).catch(() => undefined);
  await openApp(ada);
  await openChat(ada, ben);
  const list = ada.page.getByTestId("message-list");
  const divider = ada.page.getByTestId("unread-divider");
  await expect(divider).toBeVisible();
  const listBox = (await list.boundingBox())!;
  const divBox = (await divider.boundingBox())!;
  // Divider + first unread at the top of the viewport (allowing for padding and the paging spinner).
  expect(divBox.y - listBox.y).toBeGreaterThanOrEqual(0);
  expect(divBox.y - listBox.y).toBeLessThan(110);
  await expect(ada.page.getByTestId(`msg-${ids[50]}`)).toBeInViewport();
  await expect(ada.page.getByTestId(`msg-${ids[0]}`)).toHaveCount(0); // around the cursor, not from the start
  await ada.ctx.close();
  await ben.ctx.close();
});

test("AC-42/AC-45: reply jump highlights the original; go-to-bottom returns; then jumps to the end", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  const original = await send(ben, ada, "the original question");
  const filler = await seed(ben, ada, 70, "filler");
  const reply = await send(ben, ada, "about that question", original);
  await readUpTo(ada, ben, reply);
  await openApp(ada);
  await openChat(ada, ben);
  const list = ada.page.getByTestId("message-list");
  await expect(ada.page.getByTestId(`msg-${reply}`)).toBeInViewport();
  await expect(list.locator(`[data-mid='${original}']`)).toHaveCount(0); // not loaded yet
  await ada.page.getByTestId(`msg-${reply}`).getByTestId("reply-head").click();
  const target = ada.page.getByTestId(`msg-${original}`);
  await expect(target).toBeInViewport({ timeout: 10_000 });
  await expect(target.locator(".bubble.highlight")).toBeVisible();
  // Go-to-bottom returns to where the jump started (back stack).
  await ada.page.getByLabel("Jump to latest").click();
  await expect(ada.page.getByTestId(`msg-${reply}`)).toBeInViewport({ timeout: 10_000 });
  // From an older position (no unread below), go-to-bottom goes to the very end.
  await list.evaluate((el) => (el.scrollTop = 0));
  await ada.page.waitForTimeout(300);
  await ada.page.getByLabel("Jump to latest").click();
  await expect(ada.page.getByTestId(`msg-${reply}`)).toBeInViewport({ timeout: 10_000 });
  expect(filler.length).toBe(70);
  await ada.ctx.close();
  await ben.ctx.close();
});
