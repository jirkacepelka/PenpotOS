import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type SendableChannels,
} from "discord.js";
import { audit, createLogger, env, getSettings, type Settings } from "@penpotos/shared";
import { loadConversation, saveConversation } from "./conversations.ts";
import { providerFor } from "./providers/index.ts";

const log = createLogger("discord");

const MAX_CONCURRENT_TASKS = env.int("PENPOTOS_DISCORD_MAX_TASKS", 3);
const DISCORD_LIMIT = 1900;

export interface BotStatus {
  ok: boolean;
  detail: string;
  user?: string;
  activeTasks: number;
}

export function splitMessage(text: string, limit = DISCORD_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Text of the task without the bot mention. */
export function taskText(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

export class PenpotDiscordBot {
  private client?: Client;
  private token = "";
  private active = 0;
  private queues = new Map<string, Promise<unknown>>();
  private lastError = "";

  status(): BotStatus {
    if (!this.client) return { ok: true, detail: this.lastError || "Bot je vypnutý (zapni ho v admin dashboardu).", activeTasks: 0 };
    const tag = this.client.isReady() ? this.client.user.tag : undefined;
    return {
      ok: !!tag,
      detail: tag ? `Přihlášen jako ${tag}, běžící úkoly: ${this.active}` : this.lastError || "Připojuji se…",
      user: tag,
      activeTasks: this.active,
    };
  }

  /** (Re)connects or disconnects according to the admin settings. */
  async applySettings(settings: Settings) {
    const wanted = settings.discord.enabled && settings.discord.botToken ? settings.discord.botToken : "";
    if (wanted === this.token) return;
    await this.stop();
    this.token = wanted;
    if (!wanted) return;
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    });
    client.once(Events.ClientReady, (c) => {
      this.lastError = "";
      log.info(`logged in as ${c.user.tag}`);
    });
    client.on(Events.MessageCreate, (m) => this.onMessage(m).catch((err) => log.error("message handler failed", err)));
    client.on(Events.Error, (err) => {
      this.lastError = err.message;
      log.error("client error", err);
    });
    this.client = client;
    try {
      await client.login(wanted);
    } catch (err: any) {
      this.lastError = `Přihlášení selhalo: ${err.message}`;
      log.error(this.lastError);
      this.client = undefined;
      client.destroy().catch(() => {});
    }
  }

  async stop() {
    if (this.client) {
      await this.client.destroy().catch(() => {});
      this.client = undefined;
    }
    this.token = "";
  }

  private async onMessage(message: Message) {
    if (message.author.bot || !this.client?.user || !message.inGuild()) return;
    const settings = await getSettings();
    const d = settings.discord;
    const botId = this.client.user.id;
    const channel = message.channel;
    const isThread = channel.isThread();
    const inTaskChannel = d.channelIds.includes(message.channelId);
    const inTaskThread = isThread && !!channel.parentId && d.channelIds.includes(channel.parentId);
    const mentioned = message.mentions.users.has(botId);
    const existing = isThread ? await loadConversation(channel.id) : undefined;

    if (!(inTaskChannel || (inTaskThread && (existing || mentioned)) || (existing && isThread) || (d.respondToMentions && mentioned))) return;

    if (d.allowedRoleIds.length) {
      const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
      if (!member?.roles.cache.some((r) => d.allowedRoleIds.includes(r.id))) {
        if (inTaskChannel || mentioned) await message.reply("Nemáš oprávnění zadávat úkoly AI (chybí role).").catch(() => {});
        return;
      }
    }
    if (!settings.ai.mcpEnabled) {
      await message.reply("AI integrace je momentálně vypnutá administrátorem.").catch(() => {});
      return;
    }

    const text = taskText(message.content, botId);
    const imageUrls = [...message.attachments.values()].filter((a) => a.contentType?.startsWith("image/")).map((a) => a.url);
    if (!text && !imageUrls.length) return;

    // Decide where the conversation lives: an existing thread, a new thread, or the channel itself.
    let target: SendableChannels;
    let conversationId: string;
    if (isThread) {
      target = channel as unknown as SendableChannels;
      conversationId = channel.id;
    } else if (d.useThreads && channel.type === ChannelType.GuildText) {
      const name = (text || "Úkol pro AI").replace(/\s+/g, " ").slice(0, 90);
      const thread = await message.startThread({ name, autoArchiveDuration: 1440 });
      target = thread;
      conversationId = thread.id;
    } else {
      target = channel as SendableChannels;
      conversationId = message.id;
    }

    const prev = this.queues.get(conversationId) ?? Promise.resolve();
    const job = prev.then(() => this.runTask(message, target, conversationId, text, imageUrls, settings));
    this.queues.set(
      conversationId,
      job.catch(() => {}).finally(() => {
        if (this.queues.get(conversationId) === job) this.queues.delete(conversationId);
      }),
    );
  }

  private async runTask(message: Message, target: SendableChannels, conversationId: string, text: string, imageUrls: string[], settings: Settings) {
    while (this.active >= MAX_CONCURRENT_TASKS) await new Promise((r) => setTimeout(r, 1000));
    this.active++;
    const started = Date.now();
    const actor = `discord:${message.author.username}`;
    const status = await target.send("⏳ Pracuji na tom…");
    const steps: string[] = [];
    let lastEdit = 0;
    const typing = setInterval(() => target.sendTyping().catch(() => {}), 8000);
    target.sendTyping().catch(() => {});

    const onProgress = (e: { kind: string; message: string }) => {
      if (e.kind !== "tool") return;
      if (steps[steps.length - 1] !== e.message) steps.push(e.message);
      if (Date.now() - lastEdit < 2500) return;
      lastEdit = Date.now();
      status.edit(`⏳ Pracuji na tom… _${steps.slice(-4).join(" → ")}_`).catch(() => {});
    };

    try {
      const conv = await loadConversation(conversationId);
      const provider = providerFor(settings);
      const systemPrompt =
        `${settings.discord.systemPrompt}\n\n` +
        `Kontext: komunikuješ přes Discord s uživatelem ${message.member?.displayName ?? message.author.username}. ` +
        `Odpověď piš jako Discord zprávu (Markdown, max. pár odstavců). ` +
        `Pro náhled výsledku použij nástroj export_shape – exportované obrázky se automaticky přiloží ke zprávě. ` +
        `Přiložené obrázky od uživatele můžeš vložit do návrhu nástrojem import_image s jejich URL.` +
        (imageUrls.length ? `\nURL přiložených obrázků: ${imageUrls.join(" ")}` : "") +
        (settings.ai.extraInstructions ? `\n\n${settings.ai.extraInstructions}` : "");
      const result = await provider.run({
        settings,
        systemPrompt,
        input: { text: text || "(viz přiložené obrázky)", imageUrls },
        state: conv && conv.provider === settings.llm.provider ? conv.state : undefined,
        actor,
        storageKey: `discord:${conversationId}`,
        onProgress,
      });
      await saveConversation(conversationId, {
        provider: settings.llm.provider,
        state: result.state,
        turns: (conv?.turns ?? 0) + 1,
        startedBy: conv?.startedBy ?? message.author.id,
      });

      const chunks = splitMessage(result.text);
      const files = result.images.slice(-10).map((img) => new AttachmentBuilder(img.data, { name: img.name }));
      await status.edit(`✅ Hotovo za ${Math.round((Date.now() - started) / 1000)} s${steps.length ? ` · _${steps.slice(-4).join(" → ")}_` : ""}`).catch(() => {});
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        await target.send({ content: chunks[i], files: last ? files : [] });
      }
      if (!chunks.length && files.length) await target.send({ files });
      await audit({ source: "discord", actor, action: "task", target: conversationId, durationMs: Date.now() - started, detail: { text: text.slice(0, 500), steps } });
    } catch (err: any) {
      log.error("task failed", err);
      await status.edit(`❌ Úkol se nepodařilo dokončit: ${String(err.message ?? err).slice(0, 1500)}`).catch(() => {});
      await audit({ source: "discord", actor, action: "task", target: conversationId, ok: false, durationMs: Date.now() - started, detail: { text: text.slice(0, 500), error: err.message } });
    } finally {
      clearInterval(typing);
      this.active--;
    }
  }
}
