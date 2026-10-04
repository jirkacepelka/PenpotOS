/**
 * Direct read access (and a few well-scoped writes) to Penpot's own tables.
 * Profile creation and passwords always go through the PREPL API instead.
 */
import { query, queryOne } from "./db.ts";

export interface ProfileRow {
  id: string;
  email: string;
  fullname: string;
  isActive: boolean;
  isBlocked: boolean;
  createdAt: Date;
  defaultTeamId: string | null;
  role: "admin" | "member" | null;
  aiAccess: boolean | null;
  isService: boolean | null;
  managed: boolean;
  teamCount: number;
}

export interface TeamRow {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: Date;
  memberCount: number;
  ownerEmail: string | null;
  ownerName: string | null;
}

export type TeamRole = "viewer" | "editor" | "admin" | "owner";

const PROFILE_SELECT = `
  SELECT p.id, p.email, p.fullname, p.is_active AS "isActive", coalesce(p.is_blocked, false) AS "isBlocked",
         p.created_at AS "createdAt", p.default_team_id AS "defaultTeamId",
         m.role, m.ai_access AS "aiAccess", m.is_service AS "isService", (m.profile_id IS NOT NULL) AS managed,
         (SELECT count(*)::int FROM team_profile_rel tpr JOIN team t ON t.id = tpr.team_id
           WHERE tpr.profile_id = p.id AND t.deleted_at IS NULL AND NOT t.is_default) AS "teamCount"
    FROM profile p
    LEFT JOIN penpotos.members m ON m.profile_id = p.id
   WHERE p.deleted_at IS NULL`;

export async function listProfiles(): Promise<ProfileRow[]> {
  return query<ProfileRow>(`${PROFILE_SELECT} ORDER BY p.fullname`);
}

export async function getProfile(id: string): Promise<ProfileRow | undefined> {
  return queryOne<ProfileRow>(`${PROFILE_SELECT} AND p.id = $1`, [id]);
}

export async function getProfileByEmail(email: string): Promise<ProfileRow | undefined> {
  return queryOne<ProfileRow>(`${PROFILE_SELECT} AND lower(p.email) = lower($1)`, [email]);
}

export async function setProfileBlocked(id: string, blocked: boolean): Promise<void> {
  await query("UPDATE profile SET is_blocked = $2 WHERE id = $1", [id, blocked]);
  if (blocked) {
    // Invalidate active sessions so the block is effective immediately.
    await query("DELETE FROM http_session_v2 WHERE profile_id = $1", [id]).catch(() =>
      query("DELETE FROM http_session WHERE profile_id = $1", [id]).catch(() => {}),
    );
  }
}

export async function listTeams(): Promise<TeamRow[]> {
  return query<TeamRow>(`
    SELECT t.id, t.name, t.is_default AS "isDefault", t.created_at AS "createdAt",
           (SELECT count(*)::int FROM team_profile_rel tpr JOIN profile p ON p.id = tpr.profile_id
             WHERE tpr.team_id = t.id AND p.deleted_at IS NULL) AS "memberCount",
           o.email AS "ownerEmail", o.fullname AS "ownerName"
      FROM team t
      LEFT JOIN LATERAL (
        SELECT p.email, p.fullname FROM team_profile_rel tpr JOIN profile p ON p.id = tpr.profile_id
         WHERE tpr.team_id = t.id AND tpr.is_owner LIMIT 1
      ) o ON true
     WHERE t.deleted_at IS NULL
     ORDER BY t.is_default, t.name`);
}

export async function getTeam(id: string): Promise<TeamRow | undefined> {
  return (await listTeams()).find((t) => t.id === id);
}

export async function listTeamMembers(teamId: string) {
  return query<{ profileId: string; email: string; fullname: string; isOwner: boolean; isAdmin: boolean; canEdit: boolean }>(
    `SELECT p.id AS "profileId", p.email, p.fullname, tpr.is_owner AS "isOwner", tpr.is_admin AS "isAdmin", tpr.can_edit AS "canEdit"
       FROM team_profile_rel tpr JOIN profile p ON p.id = tpr.profile_id
      WHERE tpr.team_id = $1 AND p.deleted_at IS NULL ORDER BY p.fullname`,
    [teamId],
  );
}

/** Teams a profile belongs to. */
export async function profileTeamIds(profileId: string): Promise<string[]> {
  const rows = await query<{ teamId: string }>(
    `SELECT tpr.team_id AS "teamId" FROM team_profile_rel tpr JOIN team t ON t.id = tpr.team_id
      WHERE tpr.profile_id = $1 AND t.deleted_at IS NULL`,
    [profileId],
  );
  return rows.map((r) => r.teamId);
}

function roleFlags(role: TeamRole) {
  return {
    isOwner: role === "owner",
    isAdmin: role === "admin" || role === "owner",
    canEdit: role !== "viewer",
  };
}

/**
 * Adds a profile to a team (no-op when already a member).
 * Returns true when a new membership was created.
 */
export async function addTeamMember(teamId: string, profileId: string, role: TeamRole): Promise<boolean> {
  const f = roleFlags(role);
  const rows = await query(
    `INSERT INTO team_profile_rel (team_id, profile_id, is_owner, is_admin, can_edit)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING team_id`,
    [teamId, profileId, f.isOwner, f.isAdmin, f.canEdit],
  );
  return rows.length > 0;
}

export async function setTeamMemberRole(teamId: string, profileId: string, role: Exclude<TeamRole, "owner">): Promise<void> {
  const f = roleFlags(role);
  await query(
    `UPDATE team_profile_rel SET is_admin = $3, can_edit = $4 WHERE team_id = $1 AND profile_id = $2 AND NOT is_owner`,
    [teamId, profileId, f.isAdmin, f.canEdit],
  );
}

export async function removeTeamMember(teamId: string, profileId: string): Promise<void> {
  await query(`DELETE FROM team_profile_rel WHERE team_id = $1 AND profile_id = $2 AND NOT is_owner`, [teamId, profileId]);
}

/** Team id of a file (via its project). */
export async function fileTeamId(fileId: string): Promise<{ teamId: string; projectId: string; name: string } | undefined> {
  return queryOne(
    `SELECT pr.team_id AS "teamId", f.project_id AS "projectId", f.name
       FROM file f JOIN project pr ON pr.id = f.project_id
      WHERE f.id = $1 AND f.deleted_at IS NULL`,
    [fileId],
  );
}

/** Upserts PenpotOS metadata for a profile. */
export async function upsertMember(
  profileId: string,
  data: { role?: "admin" | "member"; aiAccess?: boolean; isService?: boolean; createdBy?: string; note?: string },
): Promise<void> {
  await query(
    `INSERT INTO penpotos.members (profile_id, role, ai_access, is_service, created_by, note)
     VALUES ($1, coalesce($2, 'member'), coalesce($3, true), coalesce($4, false), $5, $6)
     ON CONFLICT (profile_id) DO UPDATE SET
       role = coalesce($2, penpotos.members.role),
       ai_access = coalesce($3, penpotos.members.ai_access),
       is_service = coalesce($4, penpotos.members.is_service),
       note = coalesce($6, penpotos.members.note)`,
    [profileId, data.role ?? null, data.aiAccess ?? null, data.isService ?? null, data.createdBy ?? null, data.note ?? null],
  );
}

export async function markOnboarded(profileId: string): Promise<void> {
  await query("UPDATE penpotos.members SET onboarded_at = now() WHERE profile_id = $1", [profileId]);
}

export async function pendingOnboarding(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT m.profile_id AS id FROM penpotos.members m JOIN profile p ON p.id = m.profile_id
      WHERE m.onboarded_at IS NULL AND p.deleted_at IS NULL AND NOT m.is_service`,
  );
  return rows.map((r) => r.id);
}
