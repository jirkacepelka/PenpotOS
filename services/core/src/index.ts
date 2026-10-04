import { configDir, createLogger, env, migrate, waitForDatabase } from "@penpotos/shared";
import { startAdmin } from "./admin/server.ts";
import { ConfigError, bootstrapState, markAttempt, markError, markReady } from "./bootstrap-state.ts";
import { startGateway } from "./gateway.ts";
import { initConfigDir } from "./init-secrets.ts";
import { adoptExistingProfiles, ensureBootstrapAdmin, ensureBotAccount } from "./members.ts";
import { startSyncLoop } from "./sync.ts";

const log = createLogger("core");

function checkConfig() {
  // Secrets come from the environment or from the config volume (written by prepareConfig).
  const missing = [
    ["PENPOTOS_SECRET_KEY", env.secretKey],
    ["PENPOTOS_INTERNAL_TOKEN", env.internalToken],
  ]
    .filter(([, v]) => !v || v.length < 16)
    .map(([k]) => k);
  if (missing.length) {
    throw new ConfigError(
      `Chybí tajné klíče (${missing.join(", ")})`,
      `Klíče se generují do volume s konfigurací (${configDir()}). Zkontroluj, že je kontejneru penpotos-core připojený zapisovatelný volume, nebo klíče nastav proměnnými prostředí.`,
    );
  }
}

/**
 * Writes missing secrets and the Penpot start scripts into the config volume.
 * Postgres, the Penpot backend and the exporter wait for these files, so this runs first.
 */
let configPrepared = false;
function prepareConfig() {
  if (configPrepared) return;
  try {
    const { created } = initConfigDir(configDir());
    if (created.length) log.info(`generated ${created.join(", ")} in ${configDir()}`);
    configPrepared = true;
  } catch (err: any) {
    throw new ConfigError(
      `Nelze zapsat konfiguraci do ${configDir()}`,
      `Kontejner penpotos-core potřebuje zapisovatelný volume připojený do ${configDir()} (${err?.message ?? err}).`,
    );
  }
}

async function bootstrapOnce() {
  prepareConfig();
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

try {
  prepareConfig();
} catch {
  // Reported on the status page by the first bootstrap attempt.
}

// Both listeners start immediately: Penpot is proxied while bootstrapping and
// both ports show a diagnostic page while PenpotOS itself is not ready.
startGateway(env.int("PENPOTOS_GATEWAY_PORT", 8080));
startAdmin(env.int("PENPOTOS_ADMIN_PORT", 8081));

bootstrap().then(() => {
  startSyncLoop();
  log.info("PenpotOS core ready");
});
