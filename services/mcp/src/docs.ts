import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const VENDOR = process.env.PENPOTOS_VENDOR_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../vendor/penpot-mcp");

interface ApiType {
  name: string;
  overview: string;
  members: Record<string, Record<string, string>>;
}

const MAX_FULL_TEXT_CHARS = 2000;

let types: Map<string, ApiType> | undefined;

function loadTypes(): Map<string, ApiType> {
  if (!types) {
    const data = yaml.load(fs.readFileSync(path.join(VENDOR, "data", "api_types.yml"), "utf8")) as Record<string, any>;
    types = new Map();
    for (const [name, t] of Object.entries(data)) {
      types.set(name.toLowerCase(), { name, overview: t.overview ?? "", members: t.members ?? {} });
    }
  }
  return types;
}

export function apiTypeNames(): string[] {
  return [...loadTypes().values()].map((t) => t.name);
}

/** Same behaviour as the official `penpot_api_info` tool. */
export function apiInfo(typeName: string, member?: string): string {
  const t = loadTypes().get(typeName.toLowerCase());
  if (!t) return `Type '${typeName}' not found. Available types: ${apiTypeNames().join(", ")}`;
  if (member) {
    for (const entries of Object.values(t.members)) {
      if (member in entries) return `# ${t.name}.${member}\n\n${entries[member]}`;
    }
    return `Member '${member}' not found in type '${t.name}'.`;
  }
  let text = t.overview;
  for (const [kind, entries] of Object.entries(t.members)) {
    text += `\n\n## ${kind}\n`;
    for (const [name, desc] of Object.entries(entries)) text += `\n### ${name}\n\n${desc}`;
  }
  if (text.length > MAX_FULL_TEXT_CHARS) {
    return t.overview + "\n\nMember details not provided (too long). Call this tool with a member name for more information.";
  }
  return text;
}

const HEADLESS_PREAMBLE = `You have access to the Penpot instance of the organisation through the PenpotOS MCP server.
Unlike the official Penpot MCP setup, no browser or plugin needs to be open: PenpotOS opens design files
in a headless Penpot workspace on the server on demand.

# Working with files

* Use \`list_teams\`, \`list_projects\`, \`list_files\` and \`search_files\` to find the file you need,
  or \`create_file\` to start a new one. Use \`open_file\` to get an overview (pages, top-level boards).
* Every design tool (\`execute_code\`, \`export_shape\`, \`import_image\`) takes a \`fileId\` (and optionally a \`pageId\`).
  Within a file, \`penpot.currentFile\` / \`penpot.currentPage\` refer to that file and its current page.
* Changes are saved automatically; humans see them live when they have the file open.
* Always share the workspace link returned by the tools with the user when you created or changed something.
* The organisation's brand colours and typographies live in the shared library file (usually "Voluntia – Brand");
  prefer them over ad-hoc values (\`penpot.library.connected\`, \`penpot.library.availableLibraries()\`).
`;

let overview: string | undefined;

export function highLevelOverview(extraInstructions = ""): string {
  if (!overview) {
    let text = fs.readFileSync(path.join(VENDOR, "data", "initial_instructions.md"), "utf8");
    // The official text assumes one file connected via the browser plugin.
    text = text
      .replace(/^You have access to Penpot tools in order to interact with a Penpot design project directly\.\n/m, "")
      .replace(/^As a precondition, the user must connect the Penpot design project to the MCP server using the Penpot MCP Plugin\.\n/m, "")
      .replace("directly in the connected project.", "directly in a design file (identified by `fileId`).")
      .replace("$api_types", apiTypeNames().join(", "));
    overview = `${HEADLESS_PREAMBLE}\n${text}`;
  }
  return extraInstructions.trim() ? `${overview}\n\n# Organisation-specific instructions\n\n${extraInstructions.trim()}\n` : overview;
}

export const SERVER_INSTRUCTIONS = `You have access to the organisation's Penpot design tool (self-hosted, via PenpotOS).
Before working with design files, read the 'Penpot High-Level Overview' via the \`high_level_overview\` tool.
Find files with \`list_files\` / \`search_files\`; every design tool needs a \`fileId\`.`;
