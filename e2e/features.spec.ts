import { test, expect } from "@playwright/test";
import { actor, openApp, openChat, send } from "./helpers";

test("registration through the UI, sign out and sign back in", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const username = `reg_${Date.now().toString(36)}`;
  await page.goto("/");
  await page.getByText("New here? Create an account").click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(`${username}@example.test`);
  await page.getByLabel("Your name").fill("Reggie");
  await page.getByLabel("Password").fill("secret123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByLabel("Conversations")).toBeVisible();
  await expect(page.getByTitle("Settings")).toHaveText("Reggie");
  await page.getByRole("button", { name: "Sign out" }).click();
  // Sign back in with the email instead of the username.
  await page.getByLabel("Username or email").fill(`${username}@example.test`);
  await page.getByLabel("Password").fill("secret123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTitle("Settings")).toHaveText("Reggie");
  await ctx.close();
});

test("edit and delete-for-everyone reach the other browser", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  await send(ben, ada, "hello Ada");
  await openApp(ada);
  await openApp(ben);
  await openChat(ada, ben);
  await openChat(ben, ada);
  await ada.page.getByRole("textbox").fill("typo here");
  await ada.page.getByRole("textbox").press("Enter");
  const benList = ben.page.getByTestId("message-list");
  await expect(benList.getByText("typo here")).toBeVisible();

  const mine = ada.page.locator(".bubble-row.out").last();
  await mine.hover();
  await mine.getByLabel("Message options").click();
  await ada.page.getByRole("menuitem", { name: "Edit" }).click();
  await ada.page.getByRole("textbox").fill("fixed text");
  await ada.page.getByRole("textbox").press("Enter");
  await expect(benList.getByText("fixed text")).toBeVisible();
  await expect(benList.locator("[data-testid='edited']")).toBeVisible();

  await mine.hover();
  await mine.getByLabel("Message options").click();
  await ada.page.getByRole("menuitem", { name: "Delete" }).click();
  await ada.page.getByLabel("Also remove for Ben").check();
  await ada.page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(benList.getByText("fixed text")).toHaveCount(0);
  await ada.ctx.close();
  await ben.ctx.close();
});

test("forwarding through the picker delivers to the chosen chat", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  const cy = await actor(browser, "Cy");
  const id = await send(ben, ada, "worth sharing");
  await send(cy, ada, "hi from Cy");
  await openApp(ada);
  await openChat(ada, ben);
  const bubble = ada.page.getByTestId(`msg-${id}`);
  await bubble.hover();
  await bubble.getByLabel("Message options").click();
  await ada.page.getByRole("menuitem", { name: "Forward" }).click();
  await ada.page.getByTestId(`target-${cy.id}`).check();
  await ada.page.getByRole("dialog").getByRole("button", { name: "Send" }).click();
  await expect(ada.page.getByText(/Forwarded to Cy/)).toBeVisible();
  await openApp(cy);
  await openChat(cy, ada);
  await expect(cy.page.getByTestId("message-list").getByText("worth sharing")).toBeVisible();
  await expect(cy.page.getByTestId("fwd-head")).toHaveText("Shared from Ben");
  for (const a of [ada, ben, cy]) await a.ctx.close();
});

test("a draft typed in one browser shows up in another session of the same user", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  await send(ben, ada, "ping");
  const second = await browser.newContext();
  await second.request.post("/api/auth/login", { data: { username: ada.username, password: "secret123" } });
  const page2 = await second.newPage();
  await openApp(ada);
  await openChat(ada, ben);
  await ada.page.getByRole("textbox").fill("half-written thought");
  await page2.goto("/");
  await expect(page2.getByTestId(`dialog-${ben.id}`).getByTestId("row-subtitle")).toContainText("half-written thought", {
    timeout: 10_000,
  });
  await second.close();
  await ada.ctx.close();
  await ben.ctx.close();
});

test("a message sent while offline goes out once the network is back", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  await send(ben, ada, "you there?");
  await openApp(ada);
  await openChat(ada, ben);
  await ada.ctx.setOffline(true);
  await ada.page.getByRole("textbox").fill("sent from a tunnel");
  await ada.page.getByRole("textbox").press("Enter");
  const pending = ada.page.locator("[data-testid^='pending-']");
  await expect(pending.locator("[data-status='sending']")).toBeVisible();
  await ada.ctx.setOffline(false);
  await expect(pending).toHaveCount(0, { timeout: 20_000 });
  await expect(ada.page.locator(".bubble-row.out").last().locator("[data-status='sent'], [data-status='read']")).toBeVisible();
  const r = await ben.ctx.request.get(`/api/dialogs/${ada.id}/messages`);
  expect((await r.json()).messages[0].text).toBe("sent from a tunnel");
  await ada.ctx.close();
  await ben.ctx.close();
});

test("group chat: create in the UI, members talk, typing and sender names show", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  await openApp(ada);
  await openApp(ben);
  await ada.page.getByRole("button", { name: /New group/ }).click();
  const dlg = ada.page.getByRole("dialog", { name: "New group" });
  await dlg.getByLabel("Group name").fill("Lunch");
  await dlg.getByLabel("Add people").fill(ben.username);
  await dlg.getByTestId(`pick-${ben.id}`).check();
  await dlg.getByRole("button", { name: "Create group" }).click();
  await expect(ada.page.getByTestId("conv-sub")).toHaveText("2 members");

  const row = ben.page.locator(".row", { hasText: "Lunch" });
  await expect(row).toBeVisible();
  await row.click();
  await ben.page.getByRole("textbox").fill("pizza?");
  await expect(ada.page.getByTestId("conv-sub")).toHaveText("Ben is typing…");
  await ben.page.getByRole("textbox").press("Enter");
  const incoming = ada.page.getByTestId("message-list").locator(".bubble", { hasText: "pizza?" });
  await expect(incoming.getByTestId("sender-name")).toHaveText("Ben");
  await ada.ctx.close();
  await ben.ctx.close();
});

test("reactions and online status sync between browsers", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  const id = await send(ben, ada, "good news!");
  await openApp(ben);
  await openApp(ada);
  await openChat(ada, ben);
  await expect(ada.page.getByTestId("conv-sub")).toHaveText("online");
  const bubble = ada.page.getByTestId(`msg-${id}`);
  await bubble.hover();
  await bubble.getByLabel("Message options").click();
  await ada.page.getByLabel("React ❤️").click();
  await openChat(ben, ada);
  await expect(ben.page.getByTestId(`msg-${id}`).getByRole("button", { name: "❤️ 1" })).toBeVisible();
  await ben.ctx.close();
  await expect(ada.page.getByTestId("conv-sub")).toHaveText(/last seen/, { timeout: 10_000 });
  await ada.ctx.close();
});

test("secret chat: end-to-end encrypted in the browser, ciphertext on the server", async ({ browser }) => {
  const ada = await actor(browser, "Ada");
  const ben = await actor(browser, "Ben");
  await send(ben, ada, "hi");
  await openApp(ben); // registers Ben's device key
  await openApp(ada);
  await openChat(ada, ben);
  await ada.page.getByLabel("Chat options").click();
  await ada.page.getByRole("menuitem", { name: "Start secret chat" }).click();
  await expect(ada.page.locator(".conv-title")).toContainText("🔒");
  await ada.page.getByRole("textbox").fill("the vault code is 0451");
  await ada.page.getByRole("textbox").press("Enter");

  const secretRow = ben.page.locator(".row", { has: ben.page.getByLabel("Secret chat") });
  await expect(secretRow).toContainText("the vault code is 0451");
  await secretRow.click();
  await expect(ben.page.getByTestId("message-list").getByText("the vault code is 0451")).toBeVisible();

  // The server only has ciphertext.
  const dialogs = await (await ben.ctx.request.get("/api/dialogs")).json();
  const secret = dialogs.dialogs.find((d: { kind: string }) => d.kind === "secret");
  expect(secret.topMessage.text).toMatch(/^e1:/);
  expect(JSON.stringify(dialogs)).not.toContain("0451");

  // Both screens show the same key fingerprint.
  const code = async (p: typeof ada.page) => {
    await p.getByLabel("Chat options").click();
    await p.getByRole("menuitem", { name: "Encryption key" }).click();
    const text = (await p.getByTestId("fingerprint").textContent()) ?? "";
    await p.getByRole("button", { name: "Close" }).click();
    return text;
  };
  await expect(ada.page.getByTestId("conv-sub")).toBeVisible();
  const [fa, fb] = [await code(ada.page), await code(ben.page)];
  expect(fa).toMatch(/^[0-9A-F ]{39}$/);
  expect(fa).toBe(fb);
  await ada.ctx.close();
  await ben.ctx.close();
});
