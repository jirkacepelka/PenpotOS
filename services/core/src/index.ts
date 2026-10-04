import { createLogger, env, migrate, waitForDatabase } from "@penpotos/shared";
import { startAdmin } from "./admin/server.ts";
import { ConfigError, bootstrapState, markAttempt, markError, markReady } from "./bootstrap-state.ts";
import { startGateway } from "./gateway.ts";
import { adoptExistingProfiles, ensureBootstrapAdmin, ensureBotAccount } from "./members.ts";
import { startSyncLoop } from "./sync.ts";

const log = createLogger("core");

function checkConfig() {
  if (!env.secretKey || env.secretKey.length < 16) {
    throw new ConfigError("Chybí PENPOTOS_SECRET_KEY", "Nastav penpotos_secret_key (PENPOTOS_SECRET_KEY) na náhodný řetězec o délce alespoň 32 znaků.");
  }
  if (!env.internalToken) {
    throw new ConfigError("Chybí PENPOTOS_INTERNAL_TOKEN", "Nastav internal_token (PENPOTOS_INTERNAL_TOKEN) na náhodný řetězec.");
  }
  // Placeholders from zimaos/docker-compose.yml must be replaced before the first start.
  const values = { PENPOTOS_SECRET_KEY: env.secretKey, PENPOTOS_INTERNAL_TOKEN: env.internalToken, PENPOTOS_ADMIN_PASSWORD: env.bootstrapAdminPassword };
  const left = Object.entries(values)
    .filter(([, v]) => v.startsWith("ZMEN-"))
    .map(([k]) => k);
  if (left.length) {
    throw new ConfigError(
      `V nastavení zůstala ukázková hodnota ZMEN-… (${left.join(", ")})`,
      "V ZimaOS otevři nastavení aplikace PenpotOS (nebo YAML), nahraď všechny hodnoty začínající „ZMEN-“ vlastními náhodnými řetězci a aplikaci ulož/restartuj. " +
        "Pozor: pokud změníš i postgres_password po prvním spuštění, je potřeba smazat volume penpotos_penpot_postgres_v15.",
    );
  }
}

async function bootstrapOnce() {
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
