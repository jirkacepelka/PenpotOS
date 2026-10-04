import type { Settings } from "@penpotos/shared";

export interface UserInput {
  text: string;
  /** Image attachments from Discord (public CDN URLs). */
  imageUrls: string[];
}

export interface ProgressEvent {
  kind: "tool" | "text";
  message: string;
}

export interface TaskResult {
  text: string;
  /** Images produced by tools (e.g. export_shape) to post as attachments. */
  images: { data: Buffer; mimeType: string; name: string }[];
  /** Provider-specific conversation state to persist for follow-ups. */
  state: unknown;
}

export interface RunOptions {
  settings: Settings;
  systemPrompt: string;
  input: UserInput;
  /** State from the previous turns of the same Discord thread (provider-specific). */
  state?: unknown;
  actor: string;
  storageKey: string;
  onProgress: (e: ProgressEvent) => void;
  signal?: AbortSignal;
}

export interface Provider {
  run(opts: RunOptions): Promise<TaskResult>;
}

export const TOOL_LABELS: Record<string, string> = {
  high_level_overview: "čtu návod k Penpotu",
  penpot_api_info: "studuji Penpot API",
  list_teams: "procházím týmy",
  list_projects: "procházím projekty",
  list_files: "hledám soubory",
  search_files: "hledám soubory",
  open_file: "otevírám soubor",
  create_project: "zakládám projekt",
  create_file: "zakládám soubor",
  rename_file: "přejmenovávám soubor",
  execute_code: "upravuji návrh",
  export_shape: "exportuji náhled",
  import_image: "vkládám obrázek",
};

export function toolLabel(name: string) {
  const short = name.replace(/^mcp__penpot__/, "");
  return TOOL_LABELS[short] ?? short;
}

export function extFor(mime: string) {
  return mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : mime === "image/webp" ? "webp" : "png";
}
