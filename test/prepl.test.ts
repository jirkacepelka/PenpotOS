import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preplExec } from "../packages/shared/src/prepl.ts";

// Fake PREPL server speaking the JSON-line protocol of Penpot's app.srepl/json-repl.
let server: net.Server;
let port = 0;
const received: any[] = [];

beforeAll(async () => {
  server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const msg = JSON.parse(buf.slice(0, idx));
      received.push(msg);
      socket.write(JSON.stringify({ tag: "out", val: "log line\n" }) + "\n");
      if (msg.cmd === "fail") socket.write(JSON.stringify({ tag: "ret", err: { hint: "boom" } }) + "\n");
      else socket.write(JSON.stringify({ tag: "ret", val: { id: "p1", email: msg.params.email } }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => server.close());

describe("prepl client", () => {
  it("sends one JSON command and returns the ret value", async () => {
    const res = await preplExec<any>("create-profile", { email: "a@b.cz" }, { host: "127.0.0.1", port });
    expect(res).toEqual({ id: "p1", email: "a@b.cz" });
    expect(received.at(-1)).toEqual({ cmd: "create-profile", params: { email: "a@b.cz" } });
  });

  it("raises PREPL errors", async () => {
    await expect(preplExec("fail", {}, { host: "127.0.0.1", port })).rejects.toThrow(/boom/);
  });
});
