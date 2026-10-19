// Dev seed (OD-1): two demo users with a short conversation. Usage: npm run seed
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayServer } from "../server/app";
import { uuidV4 } from "../src/shared/text";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed in production.");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = process.env.RELAY_DB ?? path.join(root, "data", "relay.db");
const PASSWORD = "relay-demo";

async function main() {
  const { relay, close } = createRelayServer({ dbFile });
  const ensure = async (username: string, displayName: string) => {
    try {
      return (await relay.register({ username, email: `${username}@relay.local`, displayName, password: PASSWORD })).user;
    } catch {
      return (await relay.login({ username, password: PASSWORD })).user;
    }
  };
  const ada = await ensure("ada", "Ada Park");
  const ben = await ensure("ben", "Ben Okafor");
  const cy = await ensure("cyd", "Cy Ito");
  const existing = relay.listMessages(ada.id, ben.id, {}).messages.length;
  if (existing === 0) {
    const m1 = relay.sendMessage(ben.id, ada.id, { clientToken: uuidV4(), text: "Morning! Did the parcel arrive?" }).message;
    relay.sendMessage(ada.id, ben.id, { clientToken: uuidV4(), text: "It did, thanks. Opening it tonight.", replyToId: m1.id });
    relay.sendMessage(ben.id, ada.id, { clientToken: uuidV4(), text: "Great. Tell me what you think." });
    const { peerId: group } = relay.createGroup(ada.id, { title: "Weekend plans", userIds: [ben.id, cy.id] });
    relay.sendMessage(cy.id, group, { clientToken: uuidV4(), text: "Hike on Saturday?" });
    relay.sendMessage(ben.id, group, { clientToken: uuidV4(), text: "I'm in if it doesn't rain." });
  }
  await close();
  console.log(`Seeded ${dbFile}\n  ada / ${PASSWORD}\n  ben / ${PASSWORD}\n  cyd / ${PASSWORD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
