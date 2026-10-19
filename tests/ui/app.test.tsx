// @vitest-environment jsdom
// Full UI (Shell) rendered in jsdom against the real in-process server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MessengerContext } from "../../src/components/context";
import { Shell } from "../../src/components/RelayApp";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { TestClient, deferred } from "../helpers/client";

let srv: TestServer;
let a: TestUser;
let b: TestUser;
let ca: TestClient;

beforeEach(async () => {
  srv = await startServer();
  [a, b] = await twoUsers(srv);
  ca = new TestClient(srv);
  await ca.loginAs(a.user.username);
});
afterEach(async () => {
  cleanup();
  ca.stop();
  await srv.close();
});

function mount() {
  return render(
    <MessengerContext.Provider value={ca.m}>
      <Shell />
    </MessengerContext.Provider>,
  );
}

describe("app shell (jsdom)", () => {
  it("AC-9: whitespace-only send makes no request and adds no bubble", async () => {
    await b.sendOk(a, "hi A");
    mount();
    await act(() => ca.m.openConversation(b.id));
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Send"));
    await act(async () => {});
    expect(ca.callsTo("POST", /messages$/)).toHaveLength(0);
    expect(document.querySelectorAll(".bubble")).toHaveLength(1);
  });

  it("AC-10/AC-61: typed message shows as sending immediately with no delete action, row on top; then sent", async () => {
    const gate = deferred();
    ca.intercept = async (m, p) => {
      if (m === "POST" && p.endsWith("/messages")) await gate.promise;
      return "pass";
    };
    mount();
    await act(() => ca.m.openConversation(b.id));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await act(async () => {});
    const pending = document.querySelector("[data-testid^='pending-']") as HTMLElement;
    expect(pending.textContent).toContain("hello");
    expect(pending.querySelector("[data-status='sending']")).not.toBeNull();
    expect(pending.querySelector("[aria-label='Message options']")).toBeNull();
    const firstRow = document.querySelector(".dialog-list .row") as HTMLElement;
    expect(firstRow.textContent).toContain("hello");
    await act(async () => gate.resolve());
    await waitFor(() => expect(document.querySelector("[data-testid^='pending-']")).toBeNull());
    expect(document.querySelectorAll("[data-status='sent']").length).toBeGreaterThan(0);
  });

  it("AC-58: failed delete shows a notice and keeps the bubble", async () => {
    const m = await b.sendOk(a, "keep me");
    mount();
    await act(() => ca.m.openConversation(b.id));
    ca.intercept = (_m, p) => (p.endsWith("/delete") ? 500 : "pass");
    fireEvent.click(screen.getByLabelText("Message options"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getAllByText("Delete").at(-1)!);
    await waitFor(() => expect(screen.getByText(/Couldn't delete/)).toBeTruthy());
    expect(screen.getByTestId(`msg-${m.id}`)).toBeTruthy();
  });

  it("AC-41/AC-39 divider rendering: divider precedes the first unread when it is not the newest", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await b.sendOk(a, "n" + i)).id);
    await a.call("POST", `/api/dialogs/${b.id}/read`, { maxId: ids[1] });
    ca.stop();
    ca = new TestClient(srv);
    await ca.loginAs(a.user.username);
    ca.m.setFocusGate(false);
    mount();
    await act(() => ca.m.openConversation(b.id));
    const divider = screen.getByTestId("unread-divider");
    expect(divider.nextElementSibling?.getAttribute("data-mid")).toBe(String(ids[2]));
  });
});

describe("forward and multi-select through the UI", () => {
  async function setup() {
    const c = await new TestUser(srv).register("cee_ui", "Cee");
    const d = await new TestUser(srv).register("dee_ui", "Dee");
    c.sendDirect(a, "hello from C");
    d.sendDirect(a, "hello from D");
    const m1 = b.sendDirect(a, "first from B");
    const m2 = b.sendDirect(a, "second from B");
    mount();
    await waitFor(() => expect(document.querySelectorAll(".dialog-list .row")).toHaveLength(3));
    await act(() => ca.m.openConversation(b.id));
    return { c, d, m1, m2 };
  }
  const textsIn = async (u: TestUser) =>
    (await u.call("GET", `/api/dialogs/${a.id}/messages`)).body.messages.map((m: any) => m.text).reverse();

  it("AC-66 (G2): multi-target forward shows a confirmation naming the targets", async () => {
    const { c, d, m1 } = await setup();
    fireEvent.click(screen.getByTestId(`msg-${m1.id}`).querySelector("[aria-label='Message options']")!);
    fireEvent.click(screen.getByText("Forward"));
    fireEvent.click(screen.getByTestId(`target-${c.id}`));
    fireEvent.click(screen.getByTestId(`target-${d.id}`));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Send"));
    await waitFor(() => expect(screen.getByText(/Forwarded to/)).toBeTruthy());
    const toast = screen.getByText(/Forwarded to/).textContent!;
    expect(toast).toContain("Cee");
    expect(toast).toContain("Dee");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await textsIn(c)).toEqual(["hello from C", "first from B"]);
    expect(await textsIn(d)).toEqual(["hello from D", "first from B"]);
  });

  it("AC-70 (G3): forwarding a multi-selection sends every selected message in order", async () => {
    const { c, m1, m2 } = await setup();
    fireEvent.click(screen.getByTestId(`msg-${m2.id}`).querySelector("[aria-label='Message options']")!);
    fireEvent.click(screen.getByText("Select"));
    await screen.findByText("1 selected");
    fireEvent.click(screen.getByTestId(`msg-${m1.id}`));
    expect(await screen.findByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(screen.getByRole("dialog").textContent).toContain("Forwarding 2 messages");
    fireEvent.click(screen.getByTestId(`target-${c.id}`));
    fireEvent.click(screen.getByLabelText("Hide original author"));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Send"));
    await waitFor(() => expect(screen.getByText(/Forwarded to/)).toBeTruthy());
    expect(await textsIn(c)).toEqual(["hello from C", "first from B", "second from B"]);
    expect(screen.queryByText("2 selected")).toBeNull();
  });

  it("AC-70: deleting a multi-selection removes every selected message", async () => {
    const { m1, m2 } = await setup();
    fireEvent.click(screen.getByTestId(`msg-${m1.id}`).querySelector("[aria-label='Message options']")!);
    fireEvent.click(screen.getByText("Select"));
    await screen.findByText("1 selected");
    fireEvent.click(screen.getByTestId(`msg-${m2.id}`));
    await screen.findByText("2 selected");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("heading").textContent).toBe("Remove 2 messages?");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await waitFor(() => expect(screen.queryByTestId(`msg-${m1.id}`)).toBeNull());
    expect(screen.queryByTestId(`msg-${m2.id}`)).toBeNull();
  });
});
