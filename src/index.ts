import { createBot } from "./bot.ts";
import { getConfig } from "./bot.ts";

async function main() {
  console.log("Bot is starting with long polling...");
  const bot = createBot(getConfig());
  await bot.start();
}

main().catch((error) => {
  console.error("Error starting the bot:", error);
});
