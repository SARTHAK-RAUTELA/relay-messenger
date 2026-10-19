import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, type TestServer } from "../helpers/server";

let srv: TestServer;
beforeEach(async () => {
  srv = await startServer();
});
afterEach(async () => {
  await srv.close();
});

const register = (body: Record<string, unknown>) =>
  new TestUser(srv).call("POST", "/api/auth/register", { displayName: "X", password: "secret123", ...body });

describe("accounts with email", () => {
  it("sign-up needs a valid email", async () => {
    expect((await register({ username: "no_mail" })).body.error.code).toBe("VALIDATION_FAILED");
    expect((await register({ username: "bad_mail", email: "not-an-email" })).body.error.code).toBe("VALIDATION_FAILED");
    expect((await register({ username: "good_mail", email: "good@example.test" })).status).toBe(201);
  });

  it("the same email can't be used by a second account (case-insensitive)", async () => {
    expect((await register({ username: "first", email: "Same@Example.test" })).status).toBe(201);
    const dup = await register({ username: "second", email: "same@example.TEST" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("the same username can't be used twice, even with a different email", async () => {
    await register({ username: "taken", email: "a@example.test" });
    expect((await register({ username: "TAKEN", email: "b@example.test" })).body.error.code).toBe("USERNAME_TAKEN");
  });

  it("you can sign in with the username or the email, from any number of devices", async () => {
    await register({ username: "dual", email: "Dual@Example.test" });
    const phone = await new TestUser(srv).call("POST", "/api/auth/login", { username: "dual@example.test", password: "secret123" });
    const laptop = await new TestUser(srv).call("POST", "/api/auth/login", { username: "dual", password: "secret123" });
    expect(phone.status).toBe(200);
    expect(laptop.status).toBe(200);
    expect(phone.body.user.id).toBe(laptop.body.user.id);
    const wrong = await new TestUser(srv).call("POST", "/api/auth/login", { username: "dual@example.test", password: "nope-nope" });
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("the email is private: only its owner sees it", async () => {
    const a = await new TestUser(srv).register("owner_e", "Owner");
    const b = await new TestUser(srv).register("other_e", "Other");
    expect((await a.call("GET", "/api/me")).body.email).toBe("owner_e@example.test");
    await a.sendOk(b, "hi");
    const seen = JSON.stringify([
      (await b.call("GET", "/api/dialogs")).body,
      (await b.call("GET", "/api/users/search?q=owner")).body,
      (await b.call("GET", `/api/dialogs/${a.id}/messages`)).body,
    ]);
    expect(seen).not.toContain("owner_e@example.test");
  });

  it("an email can be added or changed later, but not to one that's taken", async () => {
    const a = await new TestUser(srv).register("chg_a", "A");
    await new TestUser(srv).register("chg_b", "B");
    expect((await a.call("PUT", "/api/me/email", { email: "chg_b@example.test" })).body.error.code).toBe("EMAIL_TAKEN");
    expect((await a.call("PUT", "/api/me/email", { email: "new@example.test" })).body.email).toBe("new@example.test");
    expect((await new TestUser(srv).call("POST", "/api/auth/login", { username: "new@example.test", password: "secret123" })).status).toBe(200);
  });

  it("deleting an account frees its email for a new sign-up", async () => {
    const a = await new TestUser(srv).register("leaver", "Leaver");
    await a.call("POST", "/api/me/delete", { password: "secret123" });
    expect((await register({ username: "newcomer", email: "leaver@example.test" })).status).toBe(201);
  });
});
