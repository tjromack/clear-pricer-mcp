import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, text, type Connected } from "../helpers.js";

interface Recon {
  disclosed_npis: number;
  verified_npis: number;
  unresolved_npis: number;
  undisclosed_candidates: number;
}
interface Out {
  overall: Recon;
  hospitals: {
    hospital_id: string;
    npi_reconciliation: Recon;
    disclosed_npis: { npi: string }[];
    conformance: { kind: string; records: number }[];
    provenance: { hospital_id: string; source_sha256: string };
  }[];
  notes: string[];
}

let t: Connected;
beforeAll(async () => {
  t = await connect();
});
afterAll(async () => t.close());

async function quality(args: Record<string, unknown> = {}): Promise<Out> {
  const res = await t.call("data_quality", args);
  expect(res.isError, text(res)).toBeFalsy();
  return res.structuredContent as unknown as Out;
}

describe("data_quality", () => {
  it("keeps the published ALL row separate, and it agrees with the hospital rows", async () => {
    const out = await quality();
    expect(out.hospitals.map((h) => h.hospital_id)).toEqual(["nm", "rush", "uchicago"]);
    for (const k of ["disclosed_npis", "verified_npis", "unresolved_npis", "undisclosed_candidates"] as const) {
      expect(out.hospitals.reduce((s, h) => s + h.npi_reconciliation[k], 0), k).toBe(out.overall[k]);
    }
    expect(out.overall.disclosed_npis).toBe(8); // not 16: the ALL row is never added to the hospital rows
  });

  it("lists each hospital's disclosed NPIs and template deviations with provenance", async () => {
    const out = await quality({ hospital_id: "nm" });
    expect(out.hospitals).toHaveLength(1);
    const nm = out.hospitals[0];
    expect(nm?.disclosed_npis.map((n) => n.npi)).toEqual(["1497859649", "1831298926"]);
    expect(nm?.conformance.map((c) => c.kind)).toContain("rate_dollar_percent_unreconciled");
    expect(nm?.disclosed_npis.length).toBe(nm?.npi_reconciliation.disclosed_npis);
    expect(nm?.provenance.hospital_id).toBe("nm");
  });

  it("still reports the overall row when filtered to one hospital", async () => {
    const out = await quality({ hospital_id: "rush" });
    expect(out.overall.disclosed_npis).toBe(8);
    expect(out.notes.join("\n")).toMatch(/count every NPI twice/);
  });
});
