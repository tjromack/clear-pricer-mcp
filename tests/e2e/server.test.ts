import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_PIN } from "../fixtures/pin.js";
import { connect, text, type Connected } from "../helpers.js";

let t: Connected;
beforeAll(async () => {
  t = await connect();
});
afterAll(async () => t.close());

describe("server over MCP", () => {
  it("lists every tool as read-only with an output schema", async () => {
    const { tools } = await t.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(["compare_code_prices", "release_info"]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description?.length, tool.name).toBeGreaterThan(40);
    }
  });

  it("release_info reports the pinned release and verifies check values", async () => {
    const res = await t.call("release_info");
    expect(res.isError, text(res)).toBeFalsy();
    const out = res.structuredContent as {
      release_tag: string;
      manifest_sha256: string;
      check_values_verified: boolean;
      price_files: { hospital_id: string }[];
      files: { file: string; status: string }[];
    };
    expect(out.release_tag).toBe(FIXTURE_PIN.tag);
    expect(out.manifest_sha256).toBe(FIXTURE_PIN.manifestSha256);
    expect(out.check_values_verified).toBe(true);
    expect(out.price_files.map((p) => p.hospital_id)).toEqual(["nm", "rush", "uchicago"]);
    expect(out.files.map((f) => f.file).sort()).toEqual(["agg_code_prices.parquet", "files.parquet"]);
  });

  it("answers a price question end to end with text a client without structured output can read", async () => {
    const res = await t.call("compare_code_prices", { code: "99213" });
    expect(text(res)).toMatch(/RUSH University Medical Center, outpatient: median \$185\.00/);
    expect(text(res)).toMatch(/source 362174823_rush-university-medical-center_standardcharges\.csv/);
  });
});
