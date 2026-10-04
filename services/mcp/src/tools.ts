import dns from "node:dns/promises";
import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit, botCall, createLogger, env, fileTeamId, getSettings, getState, workspaceUrl } from "@penpotos/shared";
import { AccessDeniedError, browserPool, type ExecOutcome } from "./browser.ts";
import { SERVER_INSTRUCTIONS, apiInfo, highLevelOverview } from "./docs.ts";
import { createUploadSlot, storeDownload, takeUploads } from "./files.ts";

const log = createLogger("tools");

/** Identity of the caller, resolved by the auth middleware. */
export interface Caller {
  /** Human readable actor for the audit log (e-mail or "discord:<user>"). */
  actor: string;
  profileId?: string;
  /** Key for the per-user `storage` object inside a file. */
  storageKey: string;
  source: "mcp" | "discord";
}

type ToolResult = { content: any[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

const fileIdSchema = z.string().uuid().describe("ID of the Penpot design file (see list_files / search_files / create_file).");
const pageIdSchema = z.string().uuid().optional().describe("Optional page ID; switches the file to that page before running.");

async function allowedTeams(): Promise<{ id: string; name: string }[]> {
  const settings = await getSettings(true);
  const teams: any[] = await botCall("get-teams");
  return teams
    .filter((t) => !t.isDefault)
    .filter((t) => !settings.ai.allowedTeamIds || settings.ai.allowedTeamIds.includes(t.id))
    .map((t) => ({ id: t.id, name: t.name }));
}

async function assertTeamAllowed(teamId: string) {
  const teams = await allowedTeams();
  if (!teams.some((t) => t.id === teamId)) throw new AccessDeniedError("AI nemá přístup k tomuto týmu (nastavení v admin dashboardu).");
}

async function assertWrite() {
  const settings = await getSettings(true);
  if (!settings.ai.writeEnabled) throw new AccessDeniedError("AI je v režimu jen pro čtení (nastavení v admin dashboardu).");
}

async function fileLink(fileId: string, pageId?: string) {
  const info = await fileTeamId(fileId);
  return info ? workspaceUrl(env.publicUrl, { teamId: info.teamId, fileId, pageId }) : undefined;
}

function summarizeFile(f: any, teamId?: string) {
  return {
    id: f.id,
    name: f.name,
    projectId: f.projectId,
    projectName: f.projectName,
    isSharedLibrary: f.isShared ?? undefined,
    modifiedAt: f.modifiedAt,
    link: teamId ? workspaceUrl(env.publicUrl, { teamId, fileId: f.id }) : undefined,
  };
}

function execResult(outcome: ExecOutcome): ToolResult {
  if (outcome.writeBlocked) {
    return text(
      "AI je v režimu jen pro čtení: provedené změny nebyly uloženy a byly zahozeny. " +
        (outcome.ok ? `Výsledek kódu: ${JSON.stringify(outcome.result)}` : `Chyba: ${outcome.error}`),
      true,
    );
  }
  if (!outcome.ok) {
    return text(`Error: ${outcome.error}${outcome.log ? `\n\nConsole output:\n${outcome.log}` : ""}`, true);
  }
  const data: Record<string, unknown> = { result: outcome.result ?? null };
  if (outcome.log) data.log = outcome.log;
  return outcome.result === undefined && !outcome.log ? text("Code executed successfully with no return value.") : json(data);
}

function detectMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "application/octet-stream";
}

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** True for loopback, private, link-local and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

/** Prevents the AI from using import_image to reach services inside the server's network. */
async function assertPublicUrl(u: URL) {
  if (process.env.PENPOTOS_ALLOW_PRIVATE_IMAGE_URLS === "true") return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error("Images can only be imported from public internet addresses");
}

async function fetchImage(url: string): Promise<{ data: Buffer; mime: string; name: string }> {
  let u = new URL(url);
  let res: Response | undefined;
  for (let hops = 0; hops < 5; hops++) {
    if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http(s) URLs are supported");
    await assertPublicUrl(u);
    res = await fetch(u, { signal: AbortSignal.timeout(30_000), redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      u = new URL(location, u);
      continue;
    }
    break;
  }
  if (!res) throw new Error("Download failed");
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_IMPORT_BYTES) throw new Error("Image is too large (max 25 MB)");
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_IMPORT_BYTES) throw new Error("Image is too large (max 25 MB)");
  const mime = detectMime(data);
  if (!mime.startsWith("image/")) throw new Error("Unsupported image format (supported: PNG, JPEG, GIF, WEBP)");
  const name = decodeURIComponent(u.pathname.split("/").pop() || "image").replace(/\.[a-z0-9]+$/i, "") || "image";
  return { data, mime, name };
}

/** Creates an MCP server instance exposing all PenpotOS tools for one caller. */
export async function createMcpServer(caller: Caller): Promise<McpServer> {
  // Always fresh: permission changes in the admin dashboard must apply immediately.
  const settings = await getSettings(true);
  const server = new McpServer({ name: "penpotos", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const writeEnabled = settings.ai.writeEnabled;
  const timeoutMs = settings.ai.toolTimeoutSeconds * 1000;

  /** Registers a tool with uniform auditing and error handling. */
  const tool = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; readOnly?: boolean },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  ) => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: { readOnlyHint: config.readOnly ?? false, openWorldHint: false },
      },
      (async (args: any) => {
        const started = Date.now();
        let ok = true;
        try {
          const res = await handler(args);
          ok = !res.isError;
          return res;
        } catch (err: any) {
          ok = false;
          log.warn(`${name} failed: ${err.message}`);
          return text(`Error: ${err.message}`, true);
        } finally {
          const detail: Record<string, unknown> = { ...args };
          if (typeof detail.code === "string") detail.code = (detail.code as string).slice(0, 2000);
          if (typeof detail.base64 === "string") detail.base64 = `<${(detail.base64 as string).length} chars>`;
          audit({
            source: caller.source,
            actor: caller.actor,
            action: `tool.${name}`,
            target: (args?.fileId as string) ?? (args?.projectId as string) ?? (args?.teamId as string) ?? null,
            ok,
            durationMs: Date.now() - started,
            detail,
          });
        }
      }) as any,
    );
  };

  tool(
    "high_level_overview",
    {
      title: "Penpot High-Level Overview",
      description: "Returns basic high-level instructions on the usage of Penpot-related tools and the Penpot API. Read this before any design work.",
      inputSchema: {},
      readOnly: true,
    },
    async () => text(highLevelOverview(settings.ai.extraInstructions)),
  );

  tool(
    "penpot_api_info",
    {
      title: "Penpot API documentation",
      description: "Retrieves Penpot API documentation for types and their members. Be sure to read the 'Penpot High-Level Overview' first.",
      inputSchema: { type: z.string().min(1), member: z.string().optional() },
      readOnly: true,
    },
    async ({ type, member }) => text(apiInfo(type, member)),
  );

  tool(
    "list_teams",
    { title: "List teams", description: "Lists the Penpot teams the AI can access.", inputSchema: {}, readOnly: true },
    async () => json(await allowedTeams()),
  );

  tool(
    "list_projects",
    {
      title: "List projects",
      description: "Lists projects (folders) of a team, or of all accessible teams when teamId is omitted.",
      inputSchema: { teamId: z.string().uuid().optional() },
      readOnly: true,
    },
    async ({ teamId }) => {
      const teams = await allowedTeams();
      const selected = teamId ? teams.filter((t) => t.id === teamId) : teams;
      if (teamId && !selected.length) throw new AccessDeniedError("Team not accessible");
      const out = [];
      for (const t of selected) {
        const projects: any[] = await botCall("get-projects", { teamId: t.id });
        for (const p of projects) out.push({ id: p.id, name: p.name, teamId: t.id, teamName: t.name, isDefault: p.isDefault });
      }
      return json(out);
    },
  );

  tool(
    "list_files",
    {
      title: "List files",
      description: "Lists design files in a project (projectId) or the recently modified files of a team (teamId), or of all teams.",
      inputSchema: { projectId: z.string().uuid().optional(), teamId: z.string().uuid().optional() },
      readOnly: true,
    },
    async ({ projectId, teamId }) => {
      if (projectId) {
        const project: any = await botCall("get-project", { id: projectId });
        await assertTeamAllowed(project.teamId);
        const files: any[] = await botCall("get-project-files", { projectId });
        return json(files.map((f) => summarizeFile({ ...f, projectName: project.name }, project.teamId)));
      }
      const teams = await allowedTeams();
      const selected = teamId ? teams.filter((t) => t.id === teamId) : teams;
      const out = [];
      for (const t of selected) {
        const files: any[] = await botCall("get-team-recent-files", { teamId: t.id });
        out.push(...files.map((f) => ({ ...summarizeFile(f, t.id), teamName: t.name })));
      }
      return json(out);
    },
  );

  tool(
    "search_files",
    {
      title: "Search files",
      description: "Searches design files by name across accessible teams (or within one team).",
      inputSchema: { query: z.string().min(1), teamId: z.string().uuid().optional() },
      readOnly: true,
    },
    async ({ query, teamId }) => {
      const teams = await allowedTeams();
      const selected = teamId ? teams.filter((t) => t.id === teamId) : teams;
      const out = [];
      for (const t of selected) {
        const files: any[] = await botCall("search-files", { teamId: t.id, searchTerm: query });
        out.push(...files.map((f) => ({ ...summarizeFile(f, t.id), teamName: t.name })));
      }
      return json(out);
    },
  );

  tool(
    "open_file",
    {
      title: "Open file",
      description:
        "Opens a design file on the server and returns an overview: pages, current page, top-level shapes, connected libraries and the workspace link.",
      inputSchema: { fileId: fileIdSchema, pageId: pageIdSchema },
      readOnly: true,
    },
    async ({ fileId, pageId }) => {
      const code = `
        const page = penpot.currentPage;
        return {
          file: { id: penpot.currentFile.id, name: penpot.currentFile.name },
          pages: penpotUtils.getPages(),
          currentPage: { id: page.id, name: page.name },
          topLevelShapes: page.root.children.map((s) => ({ id: s.id, name: s.name, type: s.type, x: s.x, y: s.y, width: s.width, height: s.height })),
          connectedLibraries: penpot.library.connected.map((l) => ({ id: l.id, name: l.name })),
          localLibrary: { colors: penpot.library.local.colors.length, typographies: penpot.library.local.typographies.length, components: penpot.library.local.components.length },
        };`;
      const outcome = await browserPool.exec(fileId, code, { storageKey: caller.storageKey, pageId, timeoutMs });
      if (!outcome.ok) return execResult(outcome);
      return json({ ...(outcome.result as object), link: await fileLink(fileId, (outcome.result as any)?.currentPage?.id) });
    },
  );

  if (writeEnabled) {
    tool(
      "create_project",
      { title: "Create project", description: "Creates a project (folder) in a team.", inputSchema: { teamId: z.string().uuid(), name: z.string().min(1).max(250) } },
      async ({ teamId, name }) => {
        await assertWrite();
        await assertTeamAllowed(teamId);
        const p: any = await botCall("create-project", { teamId, name });
        return json({ id: p.id, name: p.name, teamId });
      },
    );

    tool(
      "create_file",
      {
        title: "Create file",
        description: "Creates a new design file in a project. The organisation's brand library is linked automatically when configured.",
        inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(250) },
      },
      async ({ projectId, name }) => {
        await assertWrite();
        const project: any = await botCall("get-project", { id: projectId });
        await assertTeamAllowed(project.teamId);
        const f: any = await botCall("create-file", { projectId, name });
        let linkedLibrary: string | undefined;
        const s = await getSettings();
        if (s.onboarding.autoLinkLibrary) {
          const libs = (await getState<Record<string, { fileId: string }>>("brand-libraries")) ?? {};
          const lib = libs[project.teamId];
          if (lib) {
            await botCall("link-file-to-library", { fileId: f.id, libraryId: lib.fileId }).catch((e) => log.warn(`library link failed: ${e.message}`));
            linkedLibrary = s.onboarding.libraryName;
          }
        }
        return json({ id: f.id, name: f.name, projectId, linkedLibrary, link: workspaceUrl(env.publicUrl, { teamId: project.teamId, fileId: f.id }) });
      },
    );

    tool(
      "rename_file",
      { title: "Rename file", description: "Renames a design file.", inputSchema: { fileId: fileIdSchema, name: z.string().min(1).max(250) } },
      async ({ fileId, name }) => {
        await assertWrite();
        await browserPool.checkAccess(fileId);
        await botCall("rename-file", { id: fileId, name });
        return json({ id: fileId, name });
      },
    );
  }

  tool(
    "execute_code",
    {
      title: "Execute Plugin API code",
      description:
        "Executes JavaScript code in the Penpot plugin context of the given design file.\n" +
        "IMPORTANT: Before using this tool, make sure you have read the 'Penpot High-Level Overview' and know " +
        "which Penpot API functionality is necessary and how to use it.\n" +
        "You have access to the objects `penpot` (the Penpot API, of type `Penpot`), `penpotUtils`, and `storage`.\n" +
        "`storage` is an object in which arbitrary data can be stored, simply by adding a new attribute; " +
        "stored attributes can be referenced in future calls to this tool for the same file, so any intermediate results that " +
        "could come in handy later should be stored in `storage` instead of just a fleeting variable; " +
        "you can also store functions and thus build up a library).\n" +
        "Think of the code being executed as the body of a function: " +
        "The tool call returns whatever you return in the applicable `return` statement, if any. " +
        "You can return arbitrary JS objects; no need to apply JSON.stringify.\n" +
        "If an exception occurs, the exception's message will be returned to you.\n" +
        "Any output that you generate via the `console` object will be returned to you separately; so you may use it " +
        "to track what your code is doing, but you should *only* do so only if there is an ACTUAL NEED for this! " +
        "VERY IMPORTANT: Don't use logging prematurely! NEVER log the data you are returning, as you will otherwise receive it twice!\n" +
        "VERY IMPORTANT: In general, try a simple approach first, and only if it fails, try more complex code that involves " +
        "handling different cases (in particular error cases) and that applies logging." +
        (writeEnabled ? "" : "\nNOTE: The AI is currently in READ-ONLY mode; modifications will be discarded."),
      inputSchema: { fileId: fileIdSchema, code: z.string().min(1).describe("The JavaScript code to execute in the plugin context."), pageId: pageIdSchema },
    },
    async ({ fileId, code, pageId }) => execResult(await browserPool.exec(fileId, code, { storageKey: caller.storageKey, pageId, timeoutMs })),
  );

  tool(
    "export_shape",
    {
      title: "Export shape",
      description:
        "Exports a shape (or a shape's image fill) from the Penpot design to a PNG or SVG image, such that you can get an impression of what it looks like. " +
        "Set download=true to also get a download link for the user (e.g. the finished graphic) – share that link in your reply; " +
        "use scale 2–4 for a sharper result.",
      inputSchema: {
        fileId: fileIdSchema,
        shapeId: z
          .string()
          .min(1)
          .describe("Identifier of the shape to export. Special identifier: 'page' (the top-level shapes of the current page, max. 4 images)."),
        format: z.enum(["svg", "png"]).default("png").describe("The output format, either 'png' (default) or 'svg'."),
        mode: z
          .enum(["shape", "fill"])
          .default("shape")
          .describe("'shape' (full shape including descendants; default) or 'fill' (raw image used as the shape's fill; PNG only)."),
        pageId: pageIdSchema,
        download: z.boolean().default(false).describe("Also store the image and return a download link (valid 7 days) to share with the user."),
        scale: z.number().min(0.25).max(4).optional().describe("PNG resolution multiplier (default 1; 2 = retina/print quality)."),
      },
      readOnly: true,
    },
    async ({ fileId, shapeId, format, mode, pageId, download, scale }) => {
      // Penpot's exporter cannot render the page root itself, so "page" exports its top-level shapes.
      const targets =
        shapeId === "page"
          ? "penpot.root.children.slice(0, 4)"
          : shapeId === "selection"
            ? "penpot.selection.slice(0, 1)"
            : `[penpotUtils.findShapeById(${JSON.stringify(shapeId)})].filter(Boolean)`;
      const code = `const shapes = ${targets};
        if (!shapes.length) throw new Error(${JSON.stringify(shapeId === "page" ? "The page is empty" : `Shape not found: ${shapeId}`)});
        const out = [];
        for (const s of shapes) {
          const bytes = ${
            scale && scale !== 1 && mode === "shape" && format === "png"
              ? `(await new Promise((r) => setTimeout(r, 200)), await s.export({ type: "png", scale: ${Number(scale)} }))`
              : `await penpotUtils.exportImage(s, ${JSON.stringify(mode)}, ${format === "svg"})`
          };
          let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          out.push({ id: s.id, name: s.name, data: btoa(bin) });
        }
        return out;`;
      const outcome = await browserPool.exec(fileId, code, { storageKey: caller.storageKey, pageId, timeoutMs });
      if (!outcome.ok) return execResult(outcome);
      const exported = outcome.result as { id: string; name: string; data: string }[];
      const content: any[] = [];
      if (shapeId === "page") content.push({ type: "text", text: `Exported top-level shapes: ${exported.map((e) => `${e.name} (${e.id})`).join(", ")}` });
      const links: string[] = [];
      for (const e of exported) {
        const bytes = Buffer.from(e.data, "base64");
        const mimeType = format === "svg" ? "image/svg+xml" : detectMime(bytes);
        if (download) links.push(`${e.name}: ${storeDownload(bytes, mimeType, e.name)}`);
        if (format === "svg") {
          // The SVG source is only useful to the model when no download was requested.
          if (!download) content.push({ type: "text", text: bytes.toString("utf8") });
        } else content.push({ type: "image", data: e.data, mimeType });
      }
      if (links.length) {
        content.unshift({
          type: "text",
          text: `Download links for the user (valid 7 days, add ?download to force a file download):\n${links.join("\n")}`,
        });
      }
      return { content };
    },
  );

  if (writeEnabled) {
    tool(
      "import_image",
      {
        title: "Import image",
        description:
          "Imports a pixel image (from an http(s) URL or base64 data) into a design file by creating a Rectangle that uses the image as a fill. " +
          "The rectangle has the image's original proportions by default. Optionally accepts position (x, y) and dimensions (width, height); " +
          "if only one dimension is provided, the other keeps the aspect ratio. Supported formats: JPEG, PNG, GIF, WEBP. " +
          "For a photo the user has in the chat, you cannot pass its bytes – call request_image_upload, give the user the link, " +
          "then call this tool with uploadId (it waits up to 2 minutes for the upload; with several photos all are imported side by side).",
        inputSchema: {
          fileId: fileIdSchema,
          url: z.string().url().optional().describe("Image URL (e.g. a Discord attachment)."),
          base64: z.string().optional().describe("Image data as base64 (alternative to url)."),
          uploadId: z.string().optional().describe("Id returned by request_image_upload: imports the photos the user uploaded there."),
          name: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          width: z.number().positive().optional(),
          height: z.number().positive().optional(),
          pageId: pageIdSchema,
        },
      },
      async (args) => {
        await assertWrite();
        const n = (v: number | undefined) => (v === undefined ? "undefined" : String(v));
        const importOne = async (data: Buffer, mime: string, name: string, x: number | undefined) => {
          const code = `const r = await penpotUtils.importImage(${JSON.stringify(data.toString("base64"))}, ${JSON.stringify(mime)}, ${JSON.stringify(name)}, ${n(x)}, ${n(args.y)}, ${n(args.width)}, ${n(args.height)});
            return { shapeId: r.id, name: r.name, x: r.x, y: r.y, width: r.width, height: r.height };`;
          return browserPool.exec(args.fileId, code, { storageKey: caller.storageKey, pageId: args.pageId, timeoutMs });
        };
        if (args.uploadId) {
          const files = await takeUploads(args.uploadId, caller.storageKey, 120_000);
          if (!files.length) {
            return {
              content: [{ type: "text", text: "Nothing has been uploaded yet. Ask the user to upload the photo via the link and call import_image with the same uploadId again." }],
              isError: true,
            };
          }
          const results: unknown[] = [];
          let x = args.x;
          for (const [i, f] of files.entries()) {
            const outcome = await importOne(f.data, f.mime, files.length > 1 ? `${args.name ?? f.name.replace(/\.[a-z0-9]+$/i, "")} ${i + 1}` : (args.name ?? f.name.replace(/\.[a-z0-9]+$/i, "")), x);
            if (!outcome.ok) return execResult(outcome);
            const r = outcome.result as { x: number; width: number };
            results.push(outcome.result);
            // Place further photos to the right of the previous one.
            x = r.x + r.width + 40;
          }
          return { content: [{ type: "text", text: JSON.stringify({ imported: results }) }] };
        }
        let data: Buffer;
        let mime: string;
        let name = args.name;
        if (args.url) {
          const img = await fetchImage(args.url);
          data = img.data;
          mime = img.mime;
          name ??= img.name;
        } else if (args.base64) {
          data = Buffer.from(args.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
          mime = detectMime(data);
          if (!mime.startsWith("image/")) throw new Error("Unsupported image format");
        } else {
          throw new Error("Provide url, base64 or uploadId");
        }
        return execResult(await importOne(data, mime, name ?? "image", args.x));
      },
    );

    tool(
      "copy_shapes",
      {
        title: "Copy shapes to another page or file",
        description:
          "Copies shapes (boards, groups, texts, images – including nested content, image fills and component instances) " +
          "to another page of the same file or to another file, like copy & paste in Penpot. Use it to reuse templates: " +
          "copy a template board from the templates file into the target file, then edit the copy with execute_code. " +
          "The Plugin API itself can only modify the current page, so do not try to move shapes between pages in execute_code. " +
          "Returns the ids of the pasted shapes.",
        inputSchema: {
          fileId: fileIdSchema.describe("File that contains the shapes."),
          shapeIds: z.array(z.string().min(1)).min(1).max(50).describe("Ids of the shapes to copy (top-level shapes of one page)."),
          pageId: pageIdSchema.describe("Page that contains the shapes (default: the current page of the file)."),
          targetFileId: z.string().optional().describe("Target file (default: the same file)."),
          targetPageId: z.string().optional().describe("Target page (default: the current page of the target file)."),
        },
      },
      async (args) => {
        await assertWrite();
        const out = await browserPool.copyShapes({ ...args, storageKey: caller.storageKey });
        if (!out.ok) return { content: [{ type: "text", text: `Copy failed: ${out.error}` }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify({ pasted: out.pasted, targetFileId: args.targetFileId ?? args.fileId }) }] };
      },
    );

    tool(
      "request_image_upload",
      {
        title: "Request image upload",
        description:
          "Creates a private upload page (valid 2 hours) where the user can upload photos from their device. " +
          "Use it whenever the user wants to place a photo or image they have locally (e.g. attached in the chat) into a design: " +
          "you cannot pass attachment bytes to tools. Share the returned URL with the user in your reply, then call " +
          "import_image with the uploadId – it waits for the upload.",
        inputSchema: {},
      },
      async () => {
        await assertWrite();
        const { id, url } = createUploadSlot(caller.storageKey);
        return { content: [{ type: "text", text: JSON.stringify({ uploadId: id, url, validFor: "2 hours" }) }] };
      },
    );
  }

  return server;
}
