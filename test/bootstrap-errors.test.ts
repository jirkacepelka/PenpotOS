import { describe, expect, it } from "vitest";
import { ConfigError, bootstrapState, describeStartupError, markError, markReady, renderStatusPage } from "../services/core/src/bootstrap-state.ts";

describe("startup diagnostics", () => {
  it("explains a database password mismatch", () => {
    const err = Object.assign(new Error('password authentication failed for user "penpot"'), { code: "28P01" });
    expect(describeStartupError(err).title).toMatch(/Heslo databáze/);
    expect(describeStartupError(err).hint).toMatch(/penpotos_penpot_postgres_v15/);
  });

  it("explains PREPL and connection problems", () => {
    expect(describeStartupError(new Error("PREPL connection to penpot-backend:6063 failed: connect ECONNREFUSED")).title).toMatch(/PREPL/);
    expect(describeStartupError(Object.assign(new Error("connect ECONNREFUSED 172.18.0.2:5432"), { code: "ECONNREFUSED" })).title).toMatch(/spojit/);
    expect(describeStartupError(Object.assign(new Error('relation "profile" does not exist'), { code: "42P01" })).title).toMatch(/zakládá/);
  });

  it("passes configuration errors through", () => {
    const p = describeStartupError(new ConfigError("V nastavení zůstala ukázková hodnota ZMEN-…", "nahraď ji"));
    expect(p).toMatchObject({ title: "V nastavení zůstala ukázková hodnota ZMEN-…", hint: "nahraď ji" });
  });

  it("renders the current state as an escaped HTML page", () => {
    markError(new ConfigError("<b>chyba</b>", "nápověda"));
    expect(bootstrapState().status).toBe("error");
    const html = renderStatusPage();
    expect(html).toContain("PenpotOS se nespustil");
    expect(html).toContain("&#60;b&#62;chyba");
    expect(html).not.toContain("<b>chyba</b>");
    markReady();
    expect(bootstrapState().status).toBe("ready");
  });
});
