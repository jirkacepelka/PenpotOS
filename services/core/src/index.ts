import { createLogger, env, migrate, waitForDatabase } from "@penpotos/shared";
import { startAdmin } from "./admin/server.ts";
import { startGateway } from "./gateway.ts";
import { adoptExistingProfiles, ensureBootstrapAdmin, ensureBotAccount } from "./members.ts";
import { startSyncLoop } from "./sync.ts";

const log = createLogger("core");

async function bootstrap() {
  if (!env.secretKey || env.secretKey.length < 16) throw new Error("PENPOTOS_SECRET_KEY must be set (at least 16 characters)");
  if (!env.internalToken) throw new Error("PENPOTOS_INTERNAL_TOKEN must be set");
  await waitForDatabase();
  await migrate();
  // Penpot profiles that existed before PenpotOS become managed members.
  await adoptExistingProfiles();
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureBotAccount();
      await ensureBootstrapAdmin();
      break;
    } catch (err: any) {
      if (attempt >= 60) throw err;
      log.info(`waiting for Penpot backend / PREPL (${err.message})`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// The public gateway starts immediately so Penpot is reachable even while bootstrapping.
startGateway(env.int("PENPOTOS_GATEWAY_PORT", 8080));

bootstrap()
  .then(() => {
    startAdmin(env.int("PENPOTOS_ADMIN_PORT", 8081));
    startSyncLoop();
    log.info("PenpotOS core ready");
  })
  .catch((err) => {
    log.error("bootstrap failed", err);
    process.exit(1);
  });
