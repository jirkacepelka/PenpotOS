import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SECRET_FILES, initConfigDir } from "../services/core/src/init-secrets.ts";
import { env, isPlaceholder, writeConfigFile } from "../packages/shared/src/env.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "penpotos-cfg-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.PENPOTOS_CONFIG_DIR;
  delete process.env.PENPOTOS_SECRET_KEY;
  delete process.env.PENPOTOS_PUBLIC_URL;
});

describe("penpotos-init", () => {
  it("generates secrets once and never overwrites them", () => {
    const dir = tmp();
    expect(initConfigDir(dir, {}).created).toEqual([...SECRET_FILES]);
    const first = fs.readFileSync(path.join(dir, "internal_token"), "utf8");
    expect(first.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(initConfigDir(dir, {}).created).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "internal_token"), "utf8")).toBe(first);
    expect(fs.existsSync(path.join(dir, "run-backend.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "run-exporter.sh"))).toBe(true);
  });

  it("takes values from the environment but ignores placeholders", () => {
    const dir = tmp();
    const r = initConfigDir(dir, { POSTGRES_PASSWORD: "from-env", PENPOTOS_SECRET_KEY: "ZMEN-x" });
    expect(r.fromEnv).toEqual(["postgres_password"]);
    expect(fs.readFileSync(path.join(dir, "postgres_password"), "utf8").trim()).toBe("from-env");
    expect(fs.readFileSync(path.join(dir, "penpotos_secret_key"), "utf8").trim()).not.toBe("ZMEN-x");
  });
});

describe("env from config volume", () => {
  it("reads secrets and public URL from files unless set in the environment", () => {
    const dir = tmp();
    process.env.PENPOTOS_CONFIG_DIR = dir;
    initConfigDir(dir, {});
    const fileKey = fs.readFileSync(path.join(dir, "penpotos_secret_key"), "utf8").trim();
    expect(env.secretKey).toBe(fileKey);
    process.env.PENPOTOS_SECRET_KEY = "ZMEN-placeholder";
    expect(env.secretKey).toBe(fileKey);
    process.env.PENPOTOS_SECRET_KEY = "explicit";
    expect(env.secretKey).toBe("explicit");

    expect(env.publicUrlConfigured).toBe(false);
    writeConfigFile("public_url", "https://penpot.example.cz");
    expect(env.publicUrl).toBe("https://penpot.example.cz");
    expect(isPlaceholder("ZMEN-a")).toBe(true);
  });
});
