import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@penpotos/shared", async () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  env: { publicUrl: "https://penpot.example.cz" },
}));

const { createUploadSlot, filesRouter, storeDownload, takeUploads } = await import("../services/mcp/src/files.ts");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let base = "";
let server: ReturnType<express.Express["listen"]>;

beforeAll(async () => {
  const app = express();
  app.use("/mcp/files", filesRouter());
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("image exchange", () => {
  it("hands an uploaded photo to a waiting import", async () => {
    const { id, url } = createUploadSlot("user:a");
    expect(url).toBe(`https://penpot.example.cz/mcp/files/upload/${id}`);
    const waiting = takeUploads(id, "user:a", 5_000);
    const page = await fetch(`${base}/mcp/files/upload/${id}`);
    expect(page.status).toBe(200);
    const up = await fetch(`${base}/mcp/files/upload/${id}`, { method: "POST", headers: { "content-type": "image/png", "x-file-name": "foto.png" }, body: PNG });
    expect(up.status).toBe(200);
    const files = await waiting;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ mime: "image/png", name: "foto.png" });
  });

  it("rejects non-images, other users and unknown links", async () => {
    const { id } = createUploadSlot("user:a");
    const bad = await fetch(`${base}/mcp/files/upload/${id}`, { method: "POST", body: "hello" });
    expect(bad.status).toBe(400);
    await expect(takeUploads(id, "user:b", 0)).rejects.toThrow(/another user/);
    await expect(takeUploads("nope", "user:a", 0)).rejects.toThrow(/expired/);
    expect(await takeUploads(id, "user:a", 0)).toHaveLength(0);
  });

  it("serves exported images by link", async () => {
    const link = storeDownload(PNG, "image/png", "Plakát / finál");
    expect(link).toMatch(/^https:\/\/penpot\.example\.cz\/mcp\/files\/d\/[\w-]+\/Plak%C3%A1t-fin%C3%A1l\.png$/);
    const res = await fetch(base + new URL(link).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });
});
