import { webhookCallback } from "grammy";
import { createBot } from "../src/bot";
import { getConfig } from "../src/bot";

const bot = createBot(getConfig());

export default webhookCallback(bot, "https");
