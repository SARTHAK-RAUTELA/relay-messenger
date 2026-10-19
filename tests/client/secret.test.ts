// Secret chats: both clients encrypt and decrypt locally; the server only ever stores ciphertext.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { TestClient, waitUntil } from "../helpers/client";
import { MemoryKeyStore, decryptText, deriveChatKey, encryptText, generateDeviceKey, exportPublicKey } from "../../src/client/secret";
import { peerKind } from "../../src/shared/peer";
import { messages } from "../../server/db/schema";
import { uuidV4 } from "../../src/shared/text";

let srv: TestServer;
let a: TestUser;
let b: TestUser;
let ca: TestClient;
let cb: TestClient;

beforeEach(async () => {
  srv = await startServer();
  [a, b] = await twoUsers(srv);
  ca = new TestClient(srv, {}, { secretKeys: new MemoryKeyStore() });
  cb = new TestClient(srv, {}, { secretKeys: new MemoryKeyStore() });
  await ca.loginAs(a.user.username);
  await cb.loginAs(b.user.username);
  await waitUntil(() => !!ca.m.devicePublicKey && !!cb.m.devicePublicKey, 4000, "device keys");
});
afterEach(async () => {
  ca.stop();
  cb.stop();
  await srv.close();
});

const storedTexts = () => srv.app.db.select({ text: messages.text, chatId: messages.chatId }).from(messages).all();

async function startChat(): Promise<number> {
  const peer = await ca.m.startSecretChat(b.id);
  expect(peer).not.toBeNull();
  await waitUntil(() => cb.m.dialogs.has(peer!), 4000, "B sees the secret chat");
  await cb.m.idle();
  return peer!;
}

describe("secret chats", () => {
  it("crypto helpers round-trip and bind the ciphertext to the chat", async () => {
    const x = await generateDeviceKey();
    const y = await generateDeviceKey();
    const kx = await deriveChatKey(x.privateKey, await exportPublicKey(y.publicKey), 7);
    const ky = await deriveChatKey(y.privateKey, await exportPublicKey(x.publicKey), 7);
    const wire = await encryptText(kx, "héllo 👋", 7);
    expect(wire).toMatch(/^e1:/);
    expect(await decryptText(ky, wire, 7)).toBe("héllo 👋");
    const other = await deriveChatKey(y.privateKey, await exportPublicKey(x.publicKey), 8);
    await expect(decryptText(other, wire, 8)).rejects.toThrow();
  });

  it("messages are readable on both devices while the server stores only ciphertext", async () => {
    const peer = await startChat();
    expect(peerKind(peer)).toBe("secret");
    expect(ca.m.dialogs.get(peer)!.kind).toBe("secret");
    await ca.m.openConversation(peer);
    ca.m.setComposerText(peer, "meet at noon");
    ca.m.send(peer);
    await waitUntil(() => cb.m.dialogs.get(peer)?.topMessage?.text === "meet at noon", 4000, "B decrypts");
    expect(cb.m.dialogs.get(peer)!.topMessage!.undecryptable).toBeFalsy();
    await cb.m.openConversation(peer);
    expect(cb.m.convs.get(peer)!.messages.at(-1)!.text).toBe("meet at noon");

    const rows = storedTexts().filter((r) => r.chatId === peer && r.text);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toMatch(/^e1:/);
    expect(rows[0].text).not.toContain("noon");
  });

  it("replies and edits stay encrypted and decrypt on the other side", async () => {
    const peer = await startChat();
    await ca.m.openConversation(peer);
    ca.m.send(peer, "first");
    await waitUntil(() => cb.m.dialogs.get(peer)?.topMessage?.text === "first");
    await cb.m.openConversation(peer);
    const first = cb.m.convs.get(peer)!.messages.at(-1)!;
    cb.m.setReply(peer, first.id);
    cb.m.send(peer, "answer");
    await waitUntil(() => ca.m.convs.get(peer)?.messages.at(-1)?.text === "answer", 4000, "reply arrives");
    const reply = ca.m.convs.get(peer)!.messages.at(-1)!;
    expect(reply.replyTo).toMatchObject({ deleted: false, snippet: "first" });

    const mine = ca.m.convs.get(peer)!.messages.find((m) => m.text === "first")!;
    ca.m.startEdit(peer, mine.id);
    ca.m.setComposerText(peer, "first (edited)");
    await ca.m.saveEdit(peer);
    await waitUntil(() => cb.m.convs.get(peer)?.messages.some((m) => m.text === "first (edited)") ?? false, 4000, "edit");
    expect(storedTexts().every((r) => !r.text.includes("edited"))).toBe(true);
  });

  it("the server refuses plain text, drafts and forwarding for secret chats", async () => {
    const peer = await startChat();
    expect((await a.send(peer, "plain text")).body.error.code).toBe("CIPHERTEXT_INVALID");
    expect((await a.call("PUT", `/api/dialogs/${peer}/draft`, { text: "x" })).body.error.code).toBe("DRAFT_NOT_ALLOWED");
    const m = (await a.call("GET", `/api/dialogs/${peer}/messages`)).body.messages[0];
    const fwd = await a.call("POST", `/api/dialogs/${b.id}/forward`, { fromPeerId: peer, messageIds: [m.id], clientTokens: [uuidV4()] });
    expect(fwd.body.error.code).toBe("FORWARD_NOT_ALLOWED");
    // The composer text of a secret chat is never saved as a server draft.
    await ca.m.openConversation(peer);
    ca.m.setComposerText(peer, "do not upload");
    await new Promise((r) => setTimeout(r, 150));
    await ca.m.flushDraft(peer);
    expect(ca.callsTo("PUT", /\/draft$/)).toHaveLength(0);
  });

  it("another device of the same user cannot read the chat", async () => {
    const peer = await startChat();
    ca.m.send(peer, "only for device one");
    await waitUntil(() => cb.m.dialogs.get(peer)?.topMessage?.text === "only for device one");
    const second = new TestClient(srv, {}, { secretKeys: new MemoryKeyStore() });
    await second.loginAs(b.user.username);
    await waitUntil(() => !!second.m.devicePublicKey);
    await second.m.fetchDialog(peer);
    const d = second.m.dialogs.get(peer)!;
    expect(second.m.secretStatus(peer)).toBe("otherDevice");
    expect(d.topMessage!.undecryptable).toBe(true);
    second.stop();
  });

  it("both sides compute the same key fingerprint", async () => {
    const peer = await startChat();
    const fa = await ca.m.secretFingerprint(peer);
    const fb = await cb.m.secretFingerprint(peer);
    expect(fa).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
    expect(fa).toBe(fb);
  });

  it("starting a secret chat needs the other person to have a device key", async () => {
    const c = await new TestUser(srv).register("nokey_c", "Cee");
    const r = await a.call("POST", "/api/secret-chats", { userId: c.id, publicKey: ca.m.devicePublicKey });
    expect(r.body.error.code).toBe("NO_SECRET_KEY");
  });
});
