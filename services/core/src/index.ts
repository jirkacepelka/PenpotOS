import { configDir, createLogger, env, migrate, waitForDatabase } from "@penpotos/shared";
import { startAdmin } from "./admin/server.ts";
import { ConfigError, bootstrapState, markAttempt, markError, markReady } from "./bootstrap-state.ts";
import { startGateway } from "./gateway.ts";
import { initConfigDir } from "./init-secrets.ts";
import { adoptExistingProfiles, ensureBootstrapAdmin, ensureBotAccount } from "./members.ts";
import { startSyncLoop } from "./sync.ts";

const log = createLogger("core");

function checkConfig() {
  // Secrets come from the environment or from the config volume prepared by penpotos-init.
  const missing = [
    ["PENPOTOS_SECRET_KEY", env.secretKey],
    ["PENPOTOS_INTERNAL_TOKEN", env.internalToken],
  ]
    .filter(([, v]) => !v || v.length < 16)
    .map(([k]) => k);
  if (missing.length) {
    throw new ConfigError(
      `Chybí tajné klíče (${missing.join(", ")})`,
      `Klíče generuje pomocná služba penpotos-init do volume s konfigurací (${configDir()}). Zkontroluj, že tato služba v aplikaci existuje a doběhla bez chyby, nebo klíče nastav proměnnými prostředí.`,
    );
  }
}

/** Same as the penpotos-init service – core does not depend on it, so it always starts. */
function prepareConfig() {
  try {
    initConfigDir(configDir());
  } catch (err: any) {
    throw new ConfigError(
      `Nelze zapsat konfiguraci do ${configDir()}`,
      `Kontejner penpotos-core potřebuje zapisovatelný volume připojený do ${configDir()} (${err?.message ?? err}).`,
    );
  }
}

async function bootstrapOnce() {
  if (!env.secretKey || !env.internalToken) prepareConfig();
  checkConfig();
  await waitForDatabase(20_000);
  await migrate();
  // Penpot profiles that existed before PenpotOS become managed members.
  await adoptExistingProfiles();
  await ensureBotAccount();
  await ensureBootstrapAdmin();
}

/** Retries the bootstrap forever (with backoff) instead of exiting, so the problem is visible in the browser. */
async function bootstrap() {
  let delay = 5_000;
  for (;;) {
    markAttempt();
    try {
      await bootstrapOnce();
      markReady();
      return;
    } catch (err: any) {
      markError(err);
      const problem = bootstrapState().problem!;
      log.warn(`startup attempt ${bootstrapState().attempts} failed: ${problem.title} (${err?.message ?? err})`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

// Both listeners start immediately: Penpot is proxied while bootstrapping and
// both ports show a diagnostic page while PenpotOS itself is not ready.
startGateway(env.int("PENPOTOS_GATEWAY_PORT", 8080));
startAdmin(env.int("PENPOTOS_ADMIN_PORT", 8081));

bootstrap().then(() => {
  startSyncLoop();
  log.info("PenpotOS core ready");
});
