import { env } from "./env.ts";
import { getSecret } from "./state.ts";
import { PenpotRpc } from "./penpot-rpc.ts";

/** Secret key under which the AI service account password is stored. */
export const BOT_PASSWORD_KEY = "bot-password";

/** Session lifetime after which we proactively re-login. */
const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let shared: PenpotRpc | undefined;

/**
 * Returns an RPC client logged in as the AI service account
 * (re-logs in when the session gets old or after an auth error).
 */
export async function botRpc(forceLogin = false): Promise<PenpotRpc> {
  if (!forceLogin && shared?.currentSession && Date.now() - shared.currentSession.createdAt < SESSION_MAX_AGE_MS) {
    return shared;
  }
  const password = await getSecret(BOT_PASSWORD_KEY);
  if (!password) throw new Error("AI service account is not provisioned yet (core service has not started?)");
  const rpc = new PenpotRpc(env.penpotBackendUrl);
  await rpc.login(env.botEmail, password);
  shared = rpc;
  return rpc;
}

/** Runs an RPC call as the bot, retrying once with a fresh login on auth errors. */
export async function botCall<T = any>(command: string, params: Record<string, unknown> = {}): Promise<T> {
  let rpc = await botRpc();
  try {
    return await rpc.call<T>(command, params);
  } catch (err: any) {
    if (err?.status === 401 || err?.status === 403 || err?.code === "authentication-required") {
      rpc = await botRpc(true);
      return rpc.call<T>(command, params);
    }
    throw err;
  }
}
