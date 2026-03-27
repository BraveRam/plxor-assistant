import { webhookCallback } from "grammy";
import { createBot } from "../src/bot.ts";
import { getConfig } from "../src/bot.ts";

const bot = createBot(getConfig());

export default webhookCallback(bot, "https");
