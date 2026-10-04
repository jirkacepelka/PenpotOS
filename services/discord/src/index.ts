import http from "node:http";
import { INTERNAL_HEADER, createLogger, env, getSettings, isInternalRequest, migrate, waitForDatabase } from "@penpotos/shared";
import { PenpotDiscordBot } from "./bot.ts";
import { pruneConversations } from "./conversations.ts";

const log = createLogger("discord-main");
const bot = new PenpotDiscordBot();

async function main() {
  await waitForDatabase();
  await migrate();

  // Settings are edited in the admin dashboard; pick up changes periodically.
  const sync = async () => {
    try {
      await bot.applySettings(await getSettings(true));
    } catch (err) {
      log.error("failed to apply settings", err);
    }
  };
  await sync();
  setInterval(sync, 10_000).unref();
  setInterval(() => pruneConversations().catch(() => {}), 6 * 60 * 60 * 1000).unref();

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === "/internal/status" && isInternalRequest(req.headers[INTERNAL_HEADER])) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(bot.status()));
    }
    res.writeHead(404).end();
  });
  server.listen(env.int("PENPOTOS_DISCORD_PORT", 4500), () => log.info("Discord service ready"));

  const stop = async () => {
    await bot.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  log.error("startup failed", err);
  process.exit(1);
});
