// @vitest-environment jsdom
// New UI: groups, reactions, blocking, settings and secret-chat banners, against the real server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MessengerContext } from "../../src/components/context";
import { Shell } from "../../src/components/RelayApp";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { TestClient } from "../helpers/client";

configure({ asyncUtilTimeout: 5000 });

let srv: TestServer;
let a: TestUser;
let b: TestUser;
let ca: TestClient;

beforeEach(async () => {
  srv = await startServer();
  [a, b] = await twoUsers(srv);
  await b.sendOk(a, "hi Alice");
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

describe("groups UI", () => {
  it("creates a group from the sidebar and opens it with the service message", async () => {
    mount();
    fireEvent.click(screen.getByText(/New group/));
    const dlg = screen.getByRole("dialog", { name: "New group" });
    fireEvent.change(within(dlg).getByLabelText("Group name"), { target: { value: "Picnic" } });
    fireEvent.change(within(dlg).getByLabelText("Add people"), { target: { value: "bob" } });
    fireEvent.click(await within(dlg).findByTestId(`pick-${b.id}`));
    fireEvent.click(within(dlg).getByText("Create group"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("conv-sub").textContent).toBe("2 members");
    await within(screen.getByTestId("message-list")).findByText("You created the group “Picnic”");
  });

  it("shows sender names on incoming group messages and opens group info", async () => {
    const g = (await b.call("POST", "/api/groups", { title: "Team", userIds: [a.id] })).body.peerId;
    await b.sendOk(g, "standup in 5");
    mount();
    await act(() => ca.m.openConversation(g));
    const list = await screen.findByTestId("message-list");
    const bubble = (await within(list).findByText("standup in 5")).closest(".bubble") as HTMLElement;
    expect(within(bubble).getByTestId("sender-name").textContent).toBe("Bob");
    fireEvent.click(screen.getByLabelText("Chat options"));
    fireEvent.click(screen.getByText("Group info"));
    const info = screen.getByRole("dialog", { name: "Group info" });
    expect(info.textContent).toContain("2 members");
    expect(info.textContent).toContain("owner");
  });
});

describe("reactions UI", () => {
  it("reacting from the message menu shows a chip that toggles off", async () => {
    mount();
    await act(() => ca.m.openConversation(b.id));
    fireEvent.click(screen.getByLabelText("Message options"));
    fireEvent.click(screen.getByLabelText("React 👍"));
    const chip = await screen.findByRole("button", { name: "👍 1" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByTestId("reactions")).toBeNull());
  });
});

describe("blocking and settings UI", () => {
  it("blocking replaces the composer with a banner and unblock restores it", async () => {
    mount();
    await act(() => ca.m.openConversation(b.id));
    fireEvent.click(screen.getByLabelText("Chat options"));
    fireEvent.click(screen.getByText("Block"));
    const banner = await screen.findByTestId("conv-banner");
    expect(banner.textContent).toContain("You blocked this person");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(within(banner).getByText("Unblock"));
    await screen.findByRole("textbox");
  });

  it("renames the account from settings", async () => {
    mount();
    fireEvent.click(screen.getByTitle("Settings"));
    const dlg = screen.getByRole("dialog", { name: "Settings" });
    fireEvent.change(within(dlg).getByLabelText("Your name"), { target: { value: "Alice Prime" } });
    fireEvent.click(within(dlg).getByText("Save name"));
    await within(dlg).findByText("Name updated.");
    expect(screen.getByTitle("Settings").textContent).toBe("Alice Prime");
  });

  it("a secret chat on a client without device keys explains why it can't be used", async () => {
    // b starts a chat to a; b's key is registered directly, a's test client has no key store.
    const bKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64");
    const aKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString("base64");
    await b.call("PUT", "/api/keys", { publicKey: bKey });
    await a.call("PUT", "/api/keys", { publicKey: aKey });
    const peer = (await b.call("POST", "/api/secret-chats", { userId: a.id, publicKey: bKey })).body.peerId;
    mount();
    await act(() => ca.m.openConversation(peer));
    expect((await screen.findByTestId("conv-banner")).textContent).toContain("secure connection");
  });
});
