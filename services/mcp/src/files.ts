/**
 * Short-lived file exchange between the user and the MCP tools.
 *
 * Chat clients cannot hand raw attachment bytes to an MCP tool, so images travel by link:
 * - upload: `request_image_upload` creates a private page where the user drops photos;
 *   `import_image` then picks them up by upload id.
 * - download: `export_shape` with `download: true` stores the rendered image and returns a link.
 */
import express, { type Router } from "express";
import { randomBytes } from "node:crypto";
import { createLogger, env } from "@penpotos/shared";

const log = createLogger("files");

const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 10;
/** Upper bound for memory held by the store (oldest entries are dropped first). */
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;

export interface StoredFile {
  data: Buffer;
  mime: string;
  name: string;
  at: number;
}

interface UploadSlot {
  owner: string;
  expires: number;
  files: StoredFile[];
  waiters: (() => void)[];
}

interface Download extends StoredFile {
  expires: number;
}

const uploads = new Map<string, UploadSlot>();
const downloads = new Map<string, Download>();

const token = () => randomBytes(18).toString("base64url");

function totalBytes() {
  let n = 0;
  for (const s of uploads.values()) for (const f of s.files) n += f.data.length;
  for (const d of downloads.values()) n += d.data.length;
  return n;
}

function cleanup() {
  const now = Date.now();
  for (const [k, s] of uploads) if (s.expires < now) uploads.delete(k);
  for (const [k, d] of downloads) if (d.expires < now) downloads.delete(k);
  // Keep memory bounded: drop the oldest downloads first.
  while (totalBytes() > MAX_TOTAL_BYTES && downloads.size) downloads.delete(downloads.keys().next().value!);
}
setInterval(cleanup, 60_000).unref();

const base = () => `${env.publicUrl}/mcp/files`;

export function detectImageMime(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && /^GIF8[79]a/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  return undefined;
}

/** Creates an upload page for one caller and returns its id and URL. */
export function createUploadSlot(owner: string): { id: string; url: string } {
  cleanup();
  const id = token();
  uploads.set(id, { owner, expires: Date.now() + UPLOAD_TTL_MS, files: [], waiters: [] });
  return { id, url: `${base()}/upload/${id}` };
}

/**
 * Returns the files uploaded to a slot. Waits up to `waitMs` for the first file, so the
 * assistant can share the link and call this right away while the user picks a photo.
 */
export async function takeUploads(id: string, owner: string, waitMs: number): Promise<StoredFile[]> {
  const slot = uploads.get(id);
  if (!slot || slot.expires < Date.now()) throw new Error("Upload link expired or unknown – create a new one with request_image_upload.");
  if (slot.owner !== owner) throw new Error("This upload link belongs to another user.");
  if (!slot.files.length && waitMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      slot.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Give a multi-file selection a moment to finish uploading.
    if (slot.files.length) await new Promise((r) => setTimeout(r, 1500));
  }
  return slot.files;
}

/** Stores an exported image and returns a download link (valid for 7 days). */
export function storeDownload(data: Buffer, mime: string, name: string): string {
  cleanup();
  const id = token();
  const safe = (name.replace(/[^\p{L}\p{N}._ -]+/gu, "").trim() || "export").replace(/\s+/g, "-").slice(0, 80);
  const ext = mime === "image/svg+xml" ? "svg" : mime === "image/jpeg" ? "jpg" : "png";
  const fileName = safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`;
  downloads.set(id, { data, mime, name: fileName, at: Date.now(), expires: Date.now() + DOWNLOAD_TTL_MS });
  return `${base()}/d/${id}/${encodeURIComponent(fileName)}`;
}

function esc(v: string) {
  return v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function uploadPage(id: string, count: number) {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nahrát obrázek pro AI · PenpotOS</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--panel:#fff;--text:#1a1a1a;--muted:#6b6b6b;--line:#d9d9d4;--accent:#ffd200;--ok:#2e7d32}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--panel:#1e1e1e;--text:#eee;--muted:#a0a0a0;--line:#3a3a3a}}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)}
.box{max-width:560px;margin:6vh auto;padding:0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:22px;margin:0 0 8px}.logo{color:var(--accent)}p{margin:6px 0;color:var(--muted)}
label.drop{display:block;margin-top:16px;border:2px dashed var(--line);border-radius:12px;padding:36px 16px;text-align:center;cursor:pointer}
label.drop.over{border-color:var(--accent)}input{display:none}
#list{margin-top:14px;padding:0;list-style:none}#list li{padding:6px 0;border-bottom:1px solid var(--line)}
.ok{color:var(--ok);font-weight:600}.err{color:#c62828}
</style></head><body><div class="box"><div class="card">
<h1><span class="logo">◆</span> Nahrát obrázek pro AI</h1>
<p>Vyber nebo přetáhni fotky (JPG, PNG, WebP, GIF, max. 25 MB, nejvýš ${MAX_FILES_PER_UPLOAD}). Na mobilu můžeš rovnou vyfotit. Ze schránky stačí Ctrl+V.</p>
<label class="drop" id="drop">Klikni sem, nebo sem obrázky přetáhni<input id="f" type="file" accept="image/*" multiple></label>
<ul id="list"></ul>
<p id="done" ${count ? "" : "hidden"} class="ok">Hotovo – vrať se do chatu, AI si obrázky převezme.</p>
</div></div>
<script>
const list=document.getElementById('list'),done=document.getElementById('done'),drop=document.getElementById('drop');
async function send(file){const li=document.createElement('li');li.textContent=file.name+' – nahrávám…';list.appendChild(li);
 try{const r=await fetch(${JSON.stringify(`./${id}`)},{method:'POST',headers:{'content-type':file.type||'application/octet-stream','x-file-name':encodeURIComponent(file.name||'obrazek')},body:file});
 const j=await r.json();if(!r.ok)throw new Error(j.error||r.statusText);li.innerHTML='<span class="ok">✓</span> '+file.name.replace(/[<>&]/g,'');done.hidden=false;}
 catch(e){li.innerHTML='<span class="err">✗ '+String(e.message).replace(/[<>&]/g,'')+'</span>';}}
function handle(files){for(const f of files)send(f);}
document.getElementById('f').addEventListener('change',e=>handle(e.target.files));
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over')});
drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');handle(e.dataTransfer.files)});
document.addEventListener('paste',e=>{const fs=[...e.clipboardData.items].filter(i=>i.kind==='file').map(i=>i.getAsFile());if(fs.length)handle(fs)});
</script></body></html>`;
}

/** Public routes (reached through the gateway under /mcp/files). Possession of the link is the authorisation. */
export function filesRouter(): Router {
  const r = express.Router();
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex").set("Referrer-Policy", "no-referrer");
    next();
  });

  r.get("/upload/:id", (req, res) => {
    const slot = uploads.get(req.params.id);
    if (!slot || slot.expires < Date.now()) return res.status(404).send("Odkaz pro nahrání vypršel. Požádej AI o nový.");
    res.type("html").send(uploadPage(req.params.id, slot.files.length));
  });

  r.post("/upload/:id", express.raw({ type: () => true, limit: MAX_FILE_BYTES }), (req, res) => {
    const slot = uploads.get(req.params.id);
    if (!slot || slot.expires < Date.now()) return res.status(404).json({ error: "Odkaz vypršel" });
    if (slot.files.length >= MAX_FILES_PER_UPLOAD) return res.status(400).json({ error: `Nejvýš ${MAX_FILES_PER_UPLOAD} obrázků` });
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = detectImageMime(data);
    if (!mime) return res.status(400).json({ error: "Soubor není obrázek (JPG, PNG, WebP, GIF)" });
    let name = "obrazek";
    try {
      name = decodeURIComponent(String(req.get("x-file-name") ?? "obrazek")).slice(0, 120);
    } catch {
      /* keep default */
    }
    slot.files.push({ data, mime, name, at: Date.now() });
    for (const w of slot.waiters.splice(0)) w();
    log.info(`upload ${req.params.id.slice(0, 6)}…: ${name} (${Math.round(data.length / 1024)} kB)`);
    cleanup();
    res.json({ ok: true, count: slot.files.length });
  });

  r.get(["/d/:id", "/d/:id/:name"], (req, res) => {
    const d = downloads.get(String(req.params.id));
    if (!d || d.expires < Date.now()) return res.status(404).send("Soubor už není k dispozici (odkazy platí 7 dní).");
    res
      .type(d.mime)
      .set("Content-Disposition", `${req.query.download !== undefined ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(d.name)}`)
      .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
      .send(d.data);
  });

  r.use((_req, res) => res.status(404).send(esc("Nenalezeno")));
  return r;
}
