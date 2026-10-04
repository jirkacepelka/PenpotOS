export class Raw {
  constructor(public readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (v: string) => new Raw(v);

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(v: unknown): string {
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

/** Tagged template that escapes interpolations (use raw()/html`` for trusted markup). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "–";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Prague" });
}

export interface LayoutOptions {
  title: string;
  active?: string;
  user?: { fullname: string; email: string };
  flash?: { kind: "ok" | "error" | "info"; text: string } | null;
  csrf?: string;
}

const NAV = [
  ["/", "Přehled"],
  ["/users", "Uživatelé"],
  ["/teams", "Týmy"],
  ["/onboarding", "Výchozí nastavení"],
  ["/ai", "AI & MCP"],
  ["/integrations", "Discord & model"],
  ["/audit", "Audit log"],
] as const;

export function layout(opts: LayoutOptions, body: Raw): string {
  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · PenpotOS Admin</title>
<link rel="stylesheet" href="/static/admin.css">
<script src="/static/admin.js" defer></script>
</head>
<body>
${
  opts.user
    ? `<header class="top">
  <div class="brand"><span class="logo">◆</span> PenpotOS <small>admin</small></div>
  <nav>${NAV.map(([href, label]) => `<a href="${href}" class="${opts.active === href ? "active" : ""}">${label}</a>`).join("")}</nav>
  <form method="post" action="/logout" class="logout"><input type="hidden" name="_csrf" value="${esc(opts.csrf)}">
    <span title="${esc(opts.user.email)}">${esc(opts.user.fullname)}</span><button class="link">Odhlásit</button></form>
</header>`
    : ""
}
<main>
${opts.flash ? `<div class="flash ${opts.flash.kind}">${esc(opts.flash.text)}</div>` : ""}
${body.value}
</main>
</body>
</html>`;
}

export function csrfField(token: string | undefined): Raw {
  return raw(`<input type="hidden" name="_csrf" value="${esc(token)}">`);
}
