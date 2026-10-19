// Shared Playwright helpers: users are registered through the API, then drive the UI.
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

export interface Actor {
  ctx: BrowserContext;
  page: Page;
  id: number;
  username: string;
  name: string;
}

export let counter = 0;
export async function actor(browser: Browser, name: string): Promise<Actor> {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const username = `${name.toLowerCase()}_${Date.now().toString(36)}${counter++}`;
  const r = await ctx.request.post("/api/auth/register", { data: { username, email: `${username}@example.test`, displayName: name, password: "secret123" } });
  expect(r.status()).toBe(201);
  const id = (await r.json()).user.id as number;
  const page = await ctx.newPage();
  return { ctx, page, id, username, name };
}

export async function send(from: Actor, to: Actor, text: string, replyToId?: number): Promise<number> {
  const r = await from.ctx.request.post(`/api/dialogs/${to.id}/messages`, {
    data: { clientToken: randomUUID(), text, replyToId },
  });
  expect(r.status()).toBe(200);
  return (await r.json()).message.id;
}

export async function seed(from: Actor, to: Actor, n: number, prefix = "msg"): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(await send(from, to, `${prefix} ${i}`));
  return ids;
}

export async function readUpTo(reader: Actor, peer: Actor, maxId: number) {
  await reader.ctx.request.post(`/api/dialogs/${peer.id}/read`, { data: { maxId } });
}

export async function openApp(a: Actor) {
  await a.page.goto("/");
  await expect(a.page.getByLabel("Conversations")).toBeVisible();
}

export async function openChat(a: Actor, peer: Actor) {
  await a.page.getByTestId(`dialog-${peer.id}`).click();
  await expect(a.page.getByTestId("message-list")).toBeVisible();
}

export const blur = (p: Page) => p.evaluate(() => window.dispatchEvent(new Event("blur")));
export const focus = (p: Page) => p.evaluate(() => window.dispatchEvent(new Event("focus")));
