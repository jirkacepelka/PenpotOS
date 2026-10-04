import { query, queryOne } from "@penpotos/shared";

export interface Conversation {
  provider: string;
  state: unknown;
  turns: number;
  startedBy: string;
}

export async function loadConversation(id: string): Promise<Conversation | undefined> {
  const row = await queryOne<{ data: Conversation }>("SELECT data FROM penpotos.conversations WHERE id = $1", [`discord:${id}`]);
  return row?.data;
}

export async function saveConversation(id: string, data: Conversation): Promise<void> {
  await query(
    `INSERT INTO penpotos.conversations (id, source, data, updated_at) VALUES ($1, 'discord', $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [`discord:${id}`, JSON.stringify(data)],
  );
}

/** Drops conversations not touched for `days` days. */
export async function pruneConversations(days = 30): Promise<void> {
  await query("DELETE FROM penpotos.conversations WHERE source = 'discord' AND updated_at < now() - make_interval(days => $1)", [days]);
}
