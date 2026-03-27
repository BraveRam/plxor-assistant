import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import { Bot, type Context, webhookCallback } from "grammy";
import { z } from "zod";

export interface AppConfig {
  botToken: string;
  model: string;
  personaExamplesPath: string;
  memoryPath: string;
  isVercel: boolean;
  delayRangeMs: {
    min: number;
    max: number;
  };
  webhookTypingCapMs: number;
  maxMessagesPerTurn: number;
  memoryWindow: number;
  memoryRetentionMs: number;
}

type MemoryRole = "friend" | "bot";
type MemoryKind = "text" | "custom_emoji_text" | "sticker" | "gif";
type MediaIntent =
  | "laugh"
  | "crying"
  | "lovely"
  | "proud"
  | "old_pal"
  | "guilty"
  | "regretful"
  | "mischievous"
  | "roast"
  | "celebration"
  | "tired"
  | "cooked"
  | "ashamed";

interface MemoryEntry {
  role: MemoryRole;
  kind: MemoryKind;
  timestamp: string;
  text?: string;
  metadata?: Record<string, string>;
}

interface FriendMemory {
  friendId: string;
  summary: string;
  messages: MemoryEntry[];
  updatedAt: string;
}

interface PersonaExample {
  friend: string;
  incoming: string;
  replyStyle: string[];
}

interface StickerAsset {
  id: string;
  description: string;
  intents: MediaIntent[];
}

interface GifAsset {
  id: string;
  description: string;
  intents: MediaIntent[];
}

interface CustomEmojiAsset {
  id: string;
  description: string;
  intent: MediaIntent;
  fallbackEmoji: string;
}

type PlannedBotAction =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "custom_emoji_text";
      text: string;
      emojiIntent: MediaIntent;
      emoji: CustomEmojiAsset;
      fallbackEmoji: string;
    }
  | {
      kind: "sticker";
      intent: MediaIntent;
      asset: StickerAsset;
    }
  | {
      kind: "gif";
      intent: MediaIntent;
      asset: GifAsset;
    };

interface ReplyPlannerInput {
  config: AppConfig;
  incomingText: string;
  memory: FriendMemory;
}

interface PlannerState {
  actions: PlannedBotAction[];
  shouldReply: boolean;
  lastMedia: {
    kind: "sticker" | "gif";
    assetId: string;
  } | null;
}

type IncomingMessage =
  | {
      kind: "text";
      text: string;
      description: string;
    }
  | {
      kind: "sticker";
      description: string;
    }
  | {
      kind: "gif";
      description: string;
    };

type MemoryStore = Record<string, FriendMemory>;

type MediaPreference = {
  shouldPushMedia: boolean;
  preferredKind: "gif" | "sticker" | "either";
  fallbackIntent: MediaIntent;
  forceFallback: boolean;
};

const MEDIA_INTENTS = [
  "laugh",
  "crying",
  "lovely",
  "proud",
  "old_pal",
  "guilty",
  "regretful",
  "mischievous",
  "roast",
  "celebration",
  "tired",
  "cooked",
  "ashamed",
] as const satisfies readonly MediaIntent[];

const stickerAssets: StickerAsset[] = [
  {
    id: "CAACAgQAAxkBAAMRacZ3IwHoe4xH8NXJHI_bBdZI1UIAAhsVAAIelWlSw7O-9h9xv8w6BA",
    description: "sad guilty dog face",
    intents: ["guilty", "regretful"],
  },
  {
    id: "CAACAgQAAxkBAAMZacZ4dLYN0yFfSMDsf-P_T7sGiQIAAiEgAALHl3hR4GKkx99NR4M6BA",
    description: "exhausted unimpressed cat face",
    intents: ["tired", "regretful"],
  },
  {
    id: "CAACAgQAAxkBAAMhacZ407eePEnxkvkb9hFTcT7F_PYAAt4TAAIcsvlS6kFCB6uDL0o6BA",
    description: "smug playful grin",
    intents: ["mischievous", "laugh"],
  },
  {
    id: "CAACAgQAAxkBAAMpacZ50rfjHi_PbsRb0BSQT18mAAFwAAKkFgACpEVhUm9RCLDI4VrKOgQ",
    description: "wisdom is chasing you roast",
    intents: ["roast", "old_pal"],
  },
  {
    id: "CAACAgQAAxkBAAMtacZ6X_KewvpYA1NtV5osL4STm9cAArQLAAIvO7lTkbMVrExuh8U6BA",
    description: "happy dance celebration",
    intents: ["celebration", "proud", "lovely"],
  },
];

const gifAssets: GifAsset[] = [
  {
    id: "CAACAgQAAxkBAAMtacZ6X_KewvpYA1NtV5osL4STm9cAArQLAAIvO7lTkbMVrExuh8U6BA",
    description: "i'm tired boss",
    intents: ["tired"],
  },
  {
    id: "CgACAgQAAxkBAAM3acZ7aRI5b9Dc5_70uvinrT09uhcAAmAJAAIf8iRTLBw8wSqI9hg6BA",
    description: "you're cooked young man",
    intents: ["cooked", "roast"],
  },
  {
    id: "CgACAgQAAxkBAAM5acZ7kZlTi6LHAWQ1WoEYnqjuAsIAAtYEAAIBxWxQATEq_9TLMyU6BA",
    description: "this generation is cooked",
    intents: ["cooked"],
  },
  {
    id: "CgACAgIAAxkBAAM9acZ73c3rfZTTJpadGQiIMvYpaqwAAt4fAALjpxFJgzE-mlr18EE6BA",
    description: "i feel bad for myself",
    intents: ["tired", "ashamed"],
  },
  {
    id: "CgACAgQAAxkBAAM_acZ8DsrWWOtCXWALQFebvtzxtjwAAq4GAALoTkxQHRQ87iM4Nhk6BA",
    description: "i'm ashamed of myself",
    intents: ["ashamed", "guilty"],
  },
  {
    id: "CgACAgQAAxkBAANBacZ8NeJsMSZlNAH22EWSDYRxZ7IAAiIDAALcsgxTzSMo2cCpcbI6BA",
    description: "i'll bust your ass",
    intents: ["roast", "old_pal"],
  },
  {
    id: "CgACAgQAAxkBAANFacZ8f0peyVSmrgLx7tDIVoHdrLUAAtYFAAKaogRQ-ulhM6dJ5wE6BA",
    description: "you dropped your brain",
    intents: ["roast", "laugh"],
  },
  {
    id: "CgACAgQAAxkBAANJacZ8w-Zgh95JKyj3PCRUbodPzNQAAu0HAAK_fg1Q3lqzDnn-0BQ6BA",
    description: "lmao reaction",
    intents: ["laugh", "celebration"],
  },
];

const customEmojiAssets: CustomEmojiAsset[] = [
  {
    id: "5443146426567634712",
    description: "lol face",
    intent: "laugh",
    fallbackEmoji: "😂",
  },
  {
    id: "5850370495152655676",
    description: "crying face",
    intent: "crying",
    fallbackEmoji: "😭",
  },
  {
    id: "5260280338445249241",
    description: "lovely heart face",
    intent: "lovely",
    fallbackEmoji: "🥰",
  },
  {
    id: "5447480155943492724",
    description: "proud face",
    intent: "proud",
    fallbackEmoji: "🥹",
  },
  {
    id: "5260558192764532266",
    description: "old pal tease",
    intent: "old_pal",
    fallbackEmoji: "😂",
  },
];

export function getConfig(): AppConfig {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error("Missing BOT_TOKEN");
  }

  const delayMinSeconds = parseNumber(process.env.REPLY_DELAY_MIN_SECONDS, 4);
  const delayMaxSeconds = parseNumber(process.env.REPLY_DELAY_MAX_SECONDS, 8);
  const isVercel = process.env.VERCEL === "1";

  return {
    botToken,
    model: process.env.AI_MODEL ?? "xai/grok-4.1-fast-non-reasoning",
    personaExamplesPath: resolve(
      process.cwd(),
      process.env.PERSONA_EXAMPLES_PATH ?? "data/persona.examples.json",
    ),
    memoryPath: isVercel
      ? process.env.FRIEND_MEMORY_PATH ?? "/tmp/friend-memories.runtime.json"
      : resolve(
          process.cwd(),
          process.env.FRIEND_MEMORY_PATH ?? "data/friend-memories.runtime.json",
        ),
    isVercel,
    delayRangeMs: {
      min: Math.min(delayMinSeconds, delayMaxSeconds) * 1000,
      max: Math.max(delayMinSeconds, delayMaxSeconds) * 1000,
    },
    webhookTypingCapMs: parseNumber(process.env.WEBHOOK_TYPING_CAP_MS, 900),
    maxMessagesPerTurn: Math.min(
      parseNumber(process.env.MAX_MESSAGES_PER_TURN, 3),
      3,
    ),
    memoryWindow: parseNumber(process.env.MEMORY_WINDOW, 24),
    memoryRetentionMs:
      parseNumber(process.env.MEMORY_RETENTION_DAYS, 2) * 24 * 60 * 60 * 1000,
  };
}

export function createBot(config: AppConfig = getConfig()) {
  const bot = new Bot(config.botToken);

  bot.command("start", async (ctx) => {
    const payload = ctx.match;
    if (payload.startsWith("bizChat")) {
      const id = payload.slice(7);
      await ctx.reply(`locked in. i can talk in chat #${id}.`);
      return;
    }

    await ctx.reply("i'm alive.");
  });

  bot.on("business_message").filter(
    async (ctx) => {
      const conn = await ctx.getBusinessConnection();
      return ctx.from?.id !== conn.user.id;
    },
    async (ctx) => {
      const incoming = getIncomingMessage(ctx);
      if (!incoming) {
        console.log("Skipping unsupported business message");
        return;
      }

      await markBusinessMessageAsRead(ctx);

      const friendId = String(ctx.from?.id ?? ctx.chat?.id ?? "unknown");
      const friendName =
        ctx.from?.first_name ?? ctx.from?.username ?? `friend-${friendId}`;

      const memory = await getFriendMemory(
        config.memoryPath,
        friendId,
        config.memoryRetentionMs,
      );

      const plan = await planPersonaReply({
        config,
        incomingText: incoming.description,
        memory,
      });

      if (plan.actions.length > 0) {
        await executePlan(ctx, plan.actions, config);
      }

      await appendMemoryEntries(
        config.memoryPath,
        friendId,
        [createInboundEntry(incoming), ...plan.actions.map(createOutboundEntry)],
        config.memoryWindow,
        config.memoryRetentionMs,
      );
    },
  );

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  return bot;
}

async function markBusinessMessageAsRead(ctx: Context) {
  const businessConnectionId = ctx.msg?.business_connection_id;
  const chatId = ctx.chat?.id;
  const messageId = ctx.msg?.message_id;

  if (
    businessConnectionId == null ||
    chatId == null ||
    messageId == null
  ) {
    return;
  }

  try {
    await ctx.api.readBusinessMessage(
      businessConnectionId,
      chatId,
      messageId,
    );
  } catch (error) {
    console.error("Failed to mark business message as read:", error);
  }
}

const bot = createBot(getConfig());

export default webhookCallback(bot, "https");

async function planPersonaReply({
  config,
  incomingText,
  memory,
}: ReplyPlannerInput) {
  const examples = await loadPersonaExamples(config.personaExamplesPath);
  const mediaPreference = getMediaPreference(incomingText);
  const state: PlannerState = {
    actions: [],
    shouldReply: true,
    lastMedia: getLastMedia(memory),
  };

  const result = await generateText({
    model: config.model,
    system: buildSystemPrompt({
      memory,
      examples,
      maxMessagesPerTurn: config.maxMessagesPerTurn,
      mediaPreference,
    }),
    prompt: `incoming message: ${incomingText}`,
    toolChoice: "required",
    stopWhen: [hasToolCall("finish_response"), stepCountIs(8)],
    tools: {
      send_text: tool({
        description: "Queue a short text message.",
        inputSchema: z.object({
          text: z.string().min(1).max(280),
        }),
        execute: async ({ text }) => {
          queueAction(state, config, { kind: "text", text: sanitizeText(text) });
          return { queued: true, actionKind: "text", count: state.actions.length };
        },
      }),
      send_custom_emoji_text: tool({
        description: "Queue a short text message that ends with a custom emoji.",
        inputSchema: z.object({
          text: z.string().min(1).max(260),
          emojiIntent: z.enum(MEDIA_INTENTS),
        }),
        execute: async ({ text, emojiIntent }) => {
          const emoji = getCustomEmojiByIntent(emojiIntent);
          if (!emoji) {
            return { queued: false, actionKind: "custom_emoji_text" };
          }
          queueAction(state, config, {
            kind: "custom_emoji_text",
            text: sanitizeText(text),
            emojiIntent,
            emoji,
            fallbackEmoji: emoji.fallbackEmoji,
          });
          return {
            queued: true,
            actionKind: "custom_emoji_text",
            count: state.actions.length,
          };
        },
      }),
      send_sticker: tool({
        description: "Queue a sticker reaction based on a semantic mood.",
        inputSchema: z.object({ intent: z.enum(MEDIA_INTENTS) }),
        execute: async ({ intent }) => {
          const asset = resolveStickerAsset(intent, state.lastMedia);
          if (!asset) return { queued: false, actionKind: "sticker" };
          queueAction(state, config, { kind: "sticker", intent, asset });
          return { queued: true, actionKind: "sticker", count: state.actions.length };
        },
      }),
      send_gif: tool({
        description: "Queue a gif reaction based on a semantic mood.",
        inputSchema: z.object({ intent: z.enum(MEDIA_INTENTS) }),
        execute: async ({ intent }) => {
          const asset = resolveGifAsset(intent, state.lastMedia);
          if (!asset) return { queued: false, actionKind: "gif" };
          queueAction(state, config, { kind: "gif", intent, asset });
          return { queued: true, actionKind: "gif", count: state.actions.length };
        },
      }),
      finish_response: tool({
        description: "Finish the turn.",
        inputSchema: z.object({
          shouldReply: z.boolean(),
          reason: z.string().min(1).max(120),
        }),
        execute: async ({ shouldReply, reason }) => {
          state.shouldReply = shouldReply;
          return { done: true, shouldReply, reason, queuedCount: state.actions.length };
        },
      }),
    },
  });

  if (!state.shouldReply) {
    return { actions: [], modelText: result.text, steps: result.steps.length };
  }

  maybeAddFallbackMedia(state, mediaPreference, config);
  return { actions: state.actions, modelText: result.text, steps: result.steps.length };
}

function queueAction(
  state: PlannerState,
  config: AppConfig,
  action: PlannedBotAction,
) {
  if (state.actions.length >= config.maxMessagesPerTurn) return;

  const hasMediaAlready = state.actions.some(
    (existing) => existing.kind === "sticker" || existing.kind === "gif",
  );
  const isNewMedia = action.kind === "sticker" || action.kind === "gif";
  if (hasMediaAlready && isNewMedia) return;

  state.actions.push(action);
  if (action.kind === "sticker" || action.kind === "gif") {
    state.lastMedia = { kind: action.kind, assetId: action.asset.id };
  }
}

function maybeAddFallbackMedia(
  state: PlannerState,
  mediaPreference: MediaPreference,
  config: AppConfig,
) {
  if (!mediaPreference.shouldPushMedia) return;
  if (!mediaPreference.forceFallback) return;
  if (state.actions.some((action) => action.kind === "sticker" || action.kind === "gif")) return;
  if (state.actions.length >= config.maxMessagesPerTurn) return;

  const fallbackAction = buildFallbackMediaAction(mediaPreference, state.lastMedia);
  if (fallbackAction) queueAction(state, config, fallbackAction);
}

function buildFallbackMediaAction(
  mediaPreference: MediaPreference,
  lastMedia: PlannerState["lastMedia"],
): PlannedBotAction | null {
  const intent = mediaPreference.fallbackIntent;

  if (mediaPreference.preferredKind === "gif") {
    const gif = resolveGifAsset(intent, lastMedia);
    if (gif) return { kind: "gif", intent, asset: gif };
  }

  if (mediaPreference.preferredKind === "sticker") {
    const sticker = resolveStickerAsset(intent, lastMedia);
    if (sticker) return { kind: "sticker", intent, asset: sticker };
  }

  const gif = resolveGifAsset(intent, lastMedia);
  if (gif && Math.random() < 0.6) return { kind: "gif", intent, asset: gif };

  const sticker = resolveStickerAsset(intent, lastMedia);
  if (sticker) return { kind: "sticker", intent, asset: sticker };

  return gif ? { kind: "gif", intent, asset: gif } : null;
}

function resolveStickerAsset(
  intent: MediaIntent,
  lastMedia: PlannerState["lastMedia"],
) {
  const excludedId = lastMedia?.kind === "sticker" ? lastMedia.assetId : undefined;
  return getStickerByIntent(intent, excludedId);
}

function resolveGifAsset(
  intent: MediaIntent,
  lastMedia: PlannerState["lastMedia"],
) {
  const excludedId = lastMedia?.kind === "gif" ? lastMedia.assetId : undefined;
  return getGifByIntent(intent, excludedId);
}

function getMediaPreference(incomingText: string): MediaPreference {
  const lower = incomingText.toLowerCase();
  const mentionsGif = /\bgif\b|animation/.test(lower);
  const mentionsSticker = /\bsticker\b/.test(lower);
  const laughs = /\blol\b|\blmao\b|😂|🤣|hehe|haha/.test(lower);
  const cooked = /\bcooked\b|finished|done for/.test(lower);
  const tired = /\btired\b|sleepy|exhausted/.test(lower);
  const proud = /\bproud\b|nice|clean|fire|hard/.test(lower);
  const sad = /\bsad\b|sorry|my bad|ashamed|regret/.test(lower);

  let fallbackIntent: MediaIntent = "laugh";
  if (cooked) fallbackIntent = "cooked";
  else if (tired) fallbackIntent = "tired";
  else if (proud) fallbackIntent = "proud";
  else if (sad) fallbackIntent = "guilty";
  else if (laughs) fallbackIntent = "laugh";

  return {
    shouldPushMedia:
      mentionsGif ||
      mentionsSticker ||
      laughs ||
      cooked ||
      tired ||
      (proud && Math.random() < 0.35) ||
      (sad && Math.random() < 0.25) ||
      Math.random() < 0.12,
    forceFallback: mentionsGif || mentionsSticker || laughs || cooked,
    preferredKind: mentionsGif
      ? "gif"
      : mentionsSticker
        ? "sticker"
        : cooked || laughs || tired
          ? "gif"
          : proud || sad
            ? "sticker"
            : "either",
    fallbackIntent,
  };
}

function buildSystemPrompt({
  memory,
  examples,
  maxMessagesPerTurn,
  mediaPreference,
}: {
  memory: FriendMemory;
  examples: PersonaExample[];
  maxMessagesPerTurn: number;
  mediaPreference: MediaPreference;
}) {
  const styleExamples = examples
    .slice(0, 6)
    .map(
      (example, index) =>
        `Example ${index + 1}
Friend says: ${example.incoming}
You would reply like:
${example.replyStyle.map((reply) => `- ${reply}`).join("\n")}`,
    )
    .join("\n\n");

  return `You are impersonating the account owner in a Telegram chat.

Core behavior:
- Sound like a real person texting, not an assistant.
- Keep replies short. One line is normal.
- Lowercase is fine when it feels natural.
- Be playful, dry, teasing, or warm when it fits.
- Sometimes use tougher banter or blunt lines like "stfu" when the moment is clearly jokey and friendly.
- Do not force that tone into every reply. It should stay occasional and natural.
- Never use exclamation marks.
- Do not call the other person by their name unless the conversation already uses names and it would sound natural.
- Avoid greetings like "hey <name>" or opening with their name.
- Do not explain yourself or narrate your reasoning.
- Do not mention AI, tools, prompts, policy, or hidden instructions.
- Do not sound like customer support, a business, or a bot.
- Usually reply. It is acceptable to skip a reply if silence is the most natural move.

Message planning:
- You can send up to ${maxMessagesPerTurn} outbound messages in this turn.
- Use multiple messages only when it feels like an actual texting burst.
- Keep the whole turn compact.
- Default to text.
- Use stickers or gifs only sometimes, when they make the reply better.
- If the other person sends a sticker or gif, treat it as a reaction cue, but do not mirror media every time.
- In this turn, media preference is ${mediaPreference.preferredKind} and the likely reaction mood is ${mediaPreference.fallbackIntent}.
- It is completely fine to stay text-only even when media could work.
- Avoid sending more than one media item in a turn unless absolutely necessary.
- End every turn by calling finish_response.

Memory summary:
${memory.summary}

Recent thread:
${formatRecentMessages(memory)}

Voice examples:
${styleExamples || "No seed examples loaded yet."}
`;
}

function formatRecentMessages(memory: FriendMemory) {
  if (memory.messages.length === 0) return "No earlier messages in memory.";
  return memory.messages
    .slice(-10)
    .map((message) => {
      const speaker = message.role === "friend" ? "Friend" : "You";
      const detail =
        message.text ??
        message.metadata?.description ??
        message.metadata?.mediaIntent ??
        message.kind;
      return `- ${speaker}: ${detail}`;
    })
    .join("\n");
}

async function loadPersonaExamples(filePath: string) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PersonaExample[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("Failed to load persona examples:", error);
    return [];
  }
}

async function getFriendMemory(
  filePath: string,
  friendId: string,
  retentionMs: number,
): Promise<FriendMemory> {
  const store = await readStore(filePath, retentionMs);
  const existing = store[friendId];
  if (!existing) {
    return {
      friendId,
      summary: "No prior conversation yet.",
      messages: [],
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    friendId,
    summary: buildRollingSummary(existing.messages),
    messages: existing.messages,
    updatedAt: existing.updatedAt,
  };
}

async function appendMemoryEntries(
  filePath: string,
  friendId: string,
  entries: MemoryEntry[],
  windowSize: number,
  retentionMs: number,
) {
  const store = await readStore(filePath, retentionMs);
  const existing =
    store[friendId] ??
    ({
      friendId,
      summary: "No prior conversation yet.",
      messages: [],
      updatedAt: new Date().toISOString(),
    } satisfies FriendMemory);

  const messages = [...existing.messages, ...entries].slice(-windowSize);
  store[friendId] = {
    friendId,
    messages,
    summary: buildRollingSummary(messages),
    updatedAt: new Date().toISOString(),
  };
  await writeStore(filePath, store);
}

function buildRollingSummary(messages: MemoryEntry[]) {
  if (messages.length === 0) return "No prior conversation yet.";
  const summary = messages
    .slice(-8)
    .map((message) => {
      const prefix = message.role === "friend" ? "Friend" : "You";
      const body =
        message.text ??
        message.metadata?.description ??
        message.metadata?.mediaIntent ??
        message.kind;
      return `${prefix}: ${body}`;
    })
    .join(" | ");
  return summary.length > 800 ? `${summary.slice(0, 797)}...` : summary;
}

async function readStore(
  filePath: string,
  retentionMs: number,
): Promise<MemoryStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as MemoryStore;
    if (typeof parsed !== "object" || parsed === null) return {};
    if (isStoreExpired(parsed, retentionMs)) {
      await writeStore(filePath, {});
      return {};
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    console.error("Failed to read memory store:", error);
    return {};
  }
}

async function writeStore(filePath: string, store: MemoryStore) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2));
}

function isStoreExpired(store: MemoryStore, retentionMs: number) {
  const latestUpdatedAt = Object.values(store).reduce<number | null>(
    (latest, memory) => {
      const timestamp = Date.parse(memory.updatedAt);
      if (!Number.isFinite(timestamp)) return latest;
      return latest == null || timestamp > latest ? timestamp : latest;
    },
    null,
  );
  if (latestUpdatedAt == null) return false;
  return latestUpdatedAt < Date.now() - retentionMs;
}

function getIncomingMessage(ctx: Context): IncomingMessage | null {
  const text = ctx.msg?.text;
  if (typeof text === "string" && text.trim().length > 0) {
    const trimmed = text.trim();
    return { kind: "text", text: trimmed, description: trimmed };
  }

  const sticker = ctx.msg?.sticker;
  if (sticker) {
    const stickerMood = sticker.emoji ? ` with emoji ${sticker.emoji}` : "";
    return {
      kind: "sticker",
      description: `Friend sent a sticker${stickerMood}. React naturally, and a sticker or gif reply is allowed.`,
    };
  }

  const animation = ctx.msg?.animation;
  if (animation) {
    return {
      kind: "gif",
      description: `Friend sent a gif titled "${animation.file_name ?? "untitled"}". React naturally, and a gif or sticker reply is allowed.`,
    };
  }

  return null;
}

function createInboundEntry(message: IncomingMessage): MemoryEntry {
  const timestamp = new Date().toISOString();
  switch (message.kind) {
    case "text":
      return { role: "friend", kind: "text", text: message.text, timestamp };
    case "sticker":
      return {
        role: "friend",
        kind: "sticker",
        timestamp,
        metadata: { description: message.description },
      };
    case "gif":
      return {
        role: "friend",
        kind: "gif",
        timestamp,
        metadata: { description: message.description },
      };
  }
}

function createOutboundEntry(action: PlannedBotAction): MemoryEntry {
  const base = { role: "bot" as const, timestamp: new Date().toISOString() };
  switch (action.kind) {
    case "text":
      return { ...base, kind: "text", text: action.text };
    case "custom_emoji_text":
      return {
        ...base,
        kind: "custom_emoji_text",
        text: action.text,
        metadata: { emojiIntent: action.emojiIntent },
      };
    case "sticker":
      return {
        ...base,
        kind: "sticker",
        metadata: {
          mediaIntent: action.intent,
          assetId: action.asset.id,
          description: action.asset.description,
        },
      };
    case "gif":
      return {
        ...base,
        kind: "gif",
        metadata: {
          mediaIntent: action.intent,
          assetId: action.asset.id,
          description: action.asset.description,
        },
      };
  }
}

async function executePlan(
  ctx: Context,
  actions: PlannedBotAction[],
  config: AppConfig,
) {
  for (const action of actions) {
    const simulatedDelayMs = randomBetween(
      config.delayRangeMs.min,
      config.delayRangeMs.max,
    );
    const waitMs = config.isVercel
      ? Math.min(simulatedDelayMs, config.webhookTypingCapMs)
      : simulatedDelayMs;
    await showTypingEffect(ctx, waitMs);
    await sendAction(ctx, action);
  }
}

async function showTypingEffect(ctx: Context, totalDelayMs: number) {
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await delay(totalDelayMs);
    return;
  }

  const businessConnectionId = ctx.msg?.business_connection_id;
  let remainingMs = totalDelayMs;
  while (remainingMs > 0) {
    await ctx.api.sendChatAction(chatId, "typing", {
      business_connection_id: businessConnectionId,
    });
    const chunkMs = Math.min(remainingMs, 4500);
    await delay(chunkMs);
    remainingMs -= chunkMs;
  }
}

async function sendAction(ctx: Context, action: PlannedBotAction) {
  switch (action.kind) {
    case "text":
      await ctx.reply(action.text);
      return;
    case "custom_emoji_text": {
      const rendered = `${action.text} ${action.fallbackEmoji}`;
      const offset = rendered.length - action.fallbackEmoji.length;
      await ctx.reply(rendered, {
        entities: [
          {
            type: "custom_emoji",
            offset,
            length: action.fallbackEmoji.length,
            custom_emoji_id: action.emoji.id,
          },
        ],
      });
      return;
    }
    case "sticker":
      await ctx.replyWithSticker(action.asset.id);
      return;
    case "gif":
      await ctx.replyWithAnimation(action.asset.id);
      return;
  }
}

function getStickerByIntent(intent: MediaIntent, excludedId?: string) {
  return getMediaByIntent(stickerAssets, intent, excludedId);
}

function getGifByIntent(intent: MediaIntent, excludedId?: string) {
  return getMediaByIntent(gifAssets, intent, excludedId);
}

function getCustomEmojiByIntent(intent: MediaIntent) {
  return customEmojiAssets.find((asset) => asset.intent === intent) ?? null;
}

function getMediaByIntent<T extends { id: string; intents: MediaIntent[] }>(
  assets: T[],
  intent: MediaIntent,
  excludedId?: string,
) {
  const matches = assets.filter((asset) => asset.intents.includes(intent));
  if (matches.length === 0) return null;
  const filtered = excludedId
    ? matches.filter((asset) => asset.id !== excludedId)
    : matches;
  const candidates = filtered.length > 0 ? filtered : matches;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

function getLastMedia(memory: FriendMemory): PlannerState["lastMedia"] {
  const lastBotMedia = [...memory.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "bot" &&
        (message.kind === "sticker" || message.kind === "gif") &&
        message.metadata?.assetId,
    );

  if (
    !lastBotMedia ||
    (lastBotMedia.kind !== "sticker" && lastBotMedia.kind !== "gif") ||
    !lastBotMedia.metadata?.assetId
  ) {
    return null;
  }

  return { kind: lastBotMedia.kind, assetId: lastBotMedia.metadata.assetId };
}

function sanitizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
