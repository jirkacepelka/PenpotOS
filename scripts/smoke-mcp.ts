/**
 * End-to-end smoke test of the PenpotOS MCP server against a running instance.
 * Creates a file in the first accessible project, draws a board, exports it and
 * imports the export back as an image.
 *
 *   PENPOTOS_MCP_URL=http://localhost:4400/mcp PENPOTOS_INTERNAL_TOKEN=… node --import tsx scripts/smoke-mcp.ts [out.png]
 *   PENPOTOS_MCP_URL=https://penpot.example.cz/mcp PENPOTOS_MCP_TOKEN=ppos_… node --import tsx scripts/smoke-mcp.ts
 */
import fs from "node:fs";
import { PenpotMcp } from "../services/discord/src/mcp-client.ts";

const token = process.env.PENPOTOS_MCP_TOKEN;
const mcp = new PenpotMcp("smoke-test", "smoke-test", token ? { headers: { Authorization: `Bearer ${token}` } } : {});
const step = async (name: string, args: Record<string, unknown> = {}) => {
  const t = Date.now();
  const out = await mcp.call(name, args);
  console.log(`${out.isError ? "✗" : "✓"} ${name} (${Date.now() - t} ms)${out.isError ? `: ${out.text}` : ""}`);
  if (out.isError) process.exit(1);
  return out;
};

console.log("tools:", (await mcp.tools()).map((t) => t.name).join(", "));
const projects = JSON.parse((await step("list_projects")).text);
if (!projects.length) throw new Error("No accessible project – create a team in Penpot and run the sync first");
const project = projects.find((p: any) => !p.isDefault) ?? projects[0];
const file = JSON.parse((await step("create_file", { projectId: project.id, name: `MCP smoke test ${new Date().toISOString()}` })).text);
await step("open_file", { fileId: file.id });
const created = JSON.parse(
  (
    await step("execute_code", {
      fileId: file.id,
      code: `const b = penpot.createBoard(); b.name = "Smoke"; b.resize(600, 400); b.fills = [{ fillColor: "#FFD200", fillOpacity: 1 }];
             const t = penpot.createText("PenpotOS"); t.fontSize = "64"; b.appendChild(t); t.x = b.x + 40; t.y = b.y + 160;
             return { boardId: b.id };`,
    })
  ).text,
).result;
const png = await step("export_shape", { fileId: file.id, shapeId: created.boardId });
if (process.argv[2] && png.images[0]) fs.writeFileSync(process.argv[2], Buffer.from(png.images[0].data, "base64"));
await step("import_image", { fileId: file.id, base64: png.images[0].data, name: "reimport", x: 700, y: 0 });
console.log("link:", file.link);
await mcp.close();
