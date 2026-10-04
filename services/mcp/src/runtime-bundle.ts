import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let cached: Promise<string> | undefined;

/** Bundles the browser runtime (runtime/entry.ts + vendored Penpot MCP helpers) into one script. */
export function runtimeScript(): Promise<string> {
  if (!cached) {
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime", "entry.ts");
    cached = build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      target: "es2022",
      platform: "browser",
      logLevel: "silent",
    }).then((r) => r.outputFiles[0].text);
  }
  return cached;
}
