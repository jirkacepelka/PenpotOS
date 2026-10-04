import {
  BOT_PASSWORD_KEY,
  PenpotRpc,
  audit,
  createLogger,
  env,
  generatePassword,
  getProfile,
  getProfileByEmail,
  getSecret,
  getSettings,
  listProfiles,
  prepl,
  query,
  revokeProfileTokens,
  setProfileBlocked,
  setSecret,
  upsertMember,
} from "@penpotos/shared";

const log = createLogger("members");

export interface NewMember {
  fullname: string;
  email: string;
  password?: string;
  role: "admin" | "member";
  aiAccess?: boolean;
  note?: string;
}

/**
 * Creates a Penpot profile through the PREPL API (works with registration
 * disabled), registers PenpotOS metadata and marks the onboarding tutorial as seen.
 * Returns the generated password when none was supplied.
 */
export async function createMember(input: NewMember, actor: string): Promise<{ profileId: string; password: string }> {
  const email = input.email.trim().toLowerCase();
  if (await getProfileByEmail(email)) throw new Error(`Uživatel s e-mailem ${email} už existuje.`);
  const settings = await getSettings();
  const password = input.password?.trim() || generatePassword();
  if (password.length < 8) throw new Error("Heslo musí mít alespoň 8 znaků.");

  await prepl.createProfile({ fullname: input.fullname.trim(), email, password, isActive: true });
  const profile = await getProfileByEmail(email);
  if (!profile) throw new Error("Profil se nepodařilo vytvořit (PREPL nevrátil chybu, ale profil v DB chybí).");

  await upsertMember(profile.id, {
    role: input.role,
    aiAccess: input.aiAccess ?? settings.ai.defaultMemberAccess,
    createdBy: actor,
    note: input.note,
  });

  if (settings.onboarding.skipTutorial) {
    await markTutorialSeen(email, password).catch((err) => log.warn(`could not update props for ${email}`, err));
  }
  await audit({ source: "admin", actor, action: "member.create", target: email, detail: { role: input.role } });
  return { profileId: profile.id, password };
}

const ONBOARDING_DONE_PROPS = {
  "onboarding-viewed": true,
  "onboarding-questions-answered": true,
  "v2-info-shown": true,
  "workspace-visited": true,
};

/** Logs in as the user once and stores "onboarding already seen" props. */
async function markTutorialSeen(email: string, password: string, extraProps: Record<string, unknown> = {}) {
  const rpc = new PenpotRpc(env.penpotBackendUrl);
  await rpc.login(email, password);
  await rpc.call("update-profile-props", { props: { ...ONBOARDING_DONE_PROPS, ...extraProps } });
  await rpc.call("logout").catch(() => {});
}

export async function updateMember(
  profileId: string,
  data: { fullname?: string; role?: "admin" | "member"; aiAccess?: boolean; note?: string },
  actor: string,
) {
  const profile = await getProfile(profileId);
  if (!profile) throw new Error("Uživatel nenalezen.");
  if (data.fullname && data.fullname !== profile.fullname) {
    await prepl.updateProfile({ email: profile.email, fullname: data.fullname });
  }
  await upsertMember(profileId, { role: data.role, aiAccess: data.aiAccess, note: data.note });
  if (data.aiAccess === false) await revokeProfileTokens(profileId);
  await audit({ source: "admin", actor, action: "member.update", target: profile.email, detail: data });
}

export async function resetPassword(profileId: string, actor: string, password?: string): Promise<string> {
  const profile = await getProfile(profileId);
  if (!profile) throw new Error("Uživatel nenalezen.");
  const pwd = password?.trim() || generatePassword();
  if (pwd.length < 8) throw new Error("Heslo musí mít alespoň 8 znaků.");
  await prepl.updateProfile({ email: profile.email, password: pwd });
  await audit({ source: "admin", actor, action: "member.reset-password", target: profile.email });
  return pwd;
}

export async function setBlocked(profileId: string, blocked: boolean, actor: string) {
  const profile = await getProfile(profileId);
  if (!profile) throw new Error("Uživatel nenalezen.");
  if (profile.isService) throw new Error("Servisní AI účet nelze blokovat (vypni AI v nastavení).");
  await setProfileBlocked(profileId, blocked);
  if (blocked) await revokeProfileTokens(profileId);
  await audit({ source: "admin", actor, action: blocked ? "member.block" : "member.unblock", target: profile.email });
}

export async function deleteMember(profileId: string, actor: string) {
  const profile = await getProfile(profileId);
  if (!profile) throw new Error("Uživatel nenalezen.");
  if (profile.isService) throw new Error("Servisní AI účet nelze smazat.");
  await revokeProfileTokens(profileId);
  await prepl.deleteProfile(profile.email, true);
  await query("DELETE FROM penpotos.members WHERE profile_id = $1", [profileId]);
  await audit({ source: "admin", actor, action: "member.delete", target: profile.email });
}

/** Ensures the AI service account exists and its password is known. */
export async function ensureBotAccount(): Promise<string> {
  let password = await getSecret(BOT_PASSWORD_KEY);
  let profile = await getProfileByEmail(env.botEmail);
  if (!profile) {
    password = generatePassword(32);
    await prepl.createProfile({ fullname: env.botName, email: env.botEmail, password, isActive: true });
    await setSecret(BOT_PASSWORD_KEY, password);
    profile = await getProfileByEmail(env.botEmail);
    if (!profile) throw new Error("failed to create AI service account");
    log.info(`created AI service account ${env.botEmail}`);
  } else if (!password) {
    password = generatePassword(32);
    await prepl.updateProfile({ email: env.botEmail, password });
    await setSecret(BOT_PASSWORD_KEY, password);
  } else {
    // Verify the stored password still works (e.g. after a DB restore); reset otherwise.
    try {
      await new PenpotRpc(env.penpotBackendUrl).login(env.botEmail, password);
    } catch {
      password = generatePassword(32);
      await prepl.updateProfile({ email: env.botEmail, password, isActive: true });
      await setSecret(BOT_PASSWORD_KEY, password);
      log.warn("AI service account password was reset");
    }
  }
  await upsertMember(profile.id, { role: "member", aiAccess: false, isService: true, note: "Servisní účet pro AI (MCP + Discord)" });
  if (profile.isBlocked) await setProfileBlocked(profile.id, false);
  // The headless workspace uses the SVG renderer (no GPU on the server) and skips onboarding dialogs.
  await markTutorialSeen(env.botEmail, password!, { renderer: env.str("PENPOTOS_BOT_RENDERER", "svg") }).catch((err) =>
    log.warn("could not set AI account props", err.message),
  );
  return profile.id;
}

/** Creates the bootstrap administrator from environment variables (first start). */
export async function ensureBootstrapAdmin(): Promise<void> {
  const email = env.bootstrapAdminEmail.trim().toLowerCase();
  if (!email) return;
  const existing = await getProfileByEmail(email);
  if (existing) {
    if (existing.role !== "admin") await upsertMember(existing.id, { role: "admin" });
    return;
  }
  const password = env.bootstrapAdminPassword;
  if (!password) {
    log.warn("PENPOTOS_ADMIN_EMAIL is set but PENPOTOS_ADMIN_PASSWORD is empty; skipping bootstrap admin");
    return;
  }
  await createMember({ fullname: env.bootstrapAdminName, email, password, role: "admin", aiAccess: true }, "bootstrap");
  log.info(`created bootstrap administrator ${email}`);
}

/**
 * Adopts Penpot profiles that existed before PenpotOS was installed
 * (they get PenpotOS metadata with the default "member" role).
 */
export async function adoptExistingProfiles(): Promise<number> {
  const settings = await getSettings();
  let n = 0;
  for (const p of await listProfiles()) {
    if (p.managed) continue;
    await upsertMember(p.id, { role: "member", aiAccess: settings.ai.defaultMemberAccess, createdBy: "adopted" });
    n++;
  }
  if (n) log.info(`adopted ${n} pre-existing profiles`);
  return n;
}
