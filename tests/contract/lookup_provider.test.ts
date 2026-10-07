import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { str } from "../../src/db.js";
import { npiCheckDigit } from "../../src/tools/lookup_provider.js";
import { connect, text, type Connected } from "../helpers.js";

interface Out {
  npi: string;
  as_of: string | null;
  version: number;
  valid_from: string;
  valid_to: string | null;
  entity: string;
  name: string | null;
  status: string;
  versions: { version: number; valid_from: string; valid_to: string | null; valid_on_no_day: boolean }[];
  disclosed_by: { hospital_id: string; outcome: string }[];
  provenance: { table: string; nppes_file: string; read: string };
  notes: string[];
}

let t: Connected;
beforeAll(async () => {
  t = await connect();
});
afterAll(async () => t.close());

async function lookup(args: Record<string, unknown>): Promise<Out> {
  const res = await t.call("lookup_provider", args);
  expect(res.isError, text(res)).toBeFalsy();
  return res.structuredContent as unknown as Out;
}

describe("lookup_provider — as-of semantics", () => {
  it("returns the current version by default", async () => {
    const out = await lookup({ npi: "1003215880" });
    expect(out.as_of).toBeNull();
    expect(out.version).toBe(3);
    expect(out.valid_to).toBeNull();
    expect(out.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(out.provenance).toMatchObject({ table: "dim_provider_history", read: "remote_range_read" });
  });

  it("uses half-open intervals: valid_from is inclusive, valid_to exclusive", async () => {
    const all = await lookup({ npi: "1003215880" });
    const v1 = all.versions[0];
    const v2 = all.versions[1];
    if (!v1 || !v2 || !v1.valid_to) throw new Error("fixture NPI should have three versions");
    expect((await lookup({ npi: "1003215880", as_of: v1.valid_from })).version).toBe(1);
    expect((await lookup({ npi: "1003215880", as_of: v1.valid_to })).version).toBe(2); // the boundary day is v2's
    expect(v1.valid_to).toBe(v2.valid_from);
  });

  it("never answers with a version valid on no day", async () => {
    const out = await lookup({ npi: "1801771704", as_of: "2026-09-14" });
    expect(out.version).toBe(2);
    expect(out.versions.find((v) => v.version === 1)?.valid_on_no_day).toBe(true);
    expect(out.notes.join("\n")).toMatch(/valid on no day/);
  });

  it("reports a reactivated NPI's earlier deactivated version", async () => {
    const all = await lookup({ npi: "1003560616" });
    const first = all.versions[0];
    expect(first).toBeDefined();
    const then = await lookup({ npi: "1003560616", as_of: first?.valid_from });
    expect(then.status).toBe("deactivated");
    expect(all.status).toBe("active");
  });

  it("describes a deactivation-only record as entity 'unknown'", async () => {
    const [stub] = await t.db.query(
      ["dim_provider_history"],
      "SELECT npi FROM dim_provider_history WHERE entity_type IS NULL ORDER BY npi LIMIT 1",
    );
    const out = await lookup({ npi: str(stub?.["npi"]) });
    expect(out.entity).toBe("unknown");
    expect(out.name).toBeNull();
    expect(out.notes.join("\n")).toMatch(/only a deactivation notice/);
  });

  it("links an NPI to the hospital that discloses it", async () => {
    const out = await lookup({ npi: "1497859649" });
    expect(out.name).toBe("NORTHWESTERN MEMORIAL HOSPITAL");
    expect(out.entity).toBe("organization");
    expect(out.disclosed_by).toEqual([{ hospital_id: "nm", hospital_name: "Northwestern Memorial Hospital", outcome: "resolved_verified" }]);
  });
});

describe("lookup_provider — fails loudly", () => {
  it("rejects a mistyped NPI by its check digit before querying", async () => {
    const res = await t.call("lookup_provider", { npi: "1497859648" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/check digit is 8, but the first nine digits require 9/);
  });

  it("a date before the first version lists the ranges that exist", async () => {
    const res = await t.call("lookup_provider", { npi: "1003215880", as_of: "1999-01-01" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/version 1: active, valid /);
  });

  it("an impossible date is refused", async () => {
    const res = await t.call("lookup_provider", { npi: "1003215880", as_of: "2026-02-30" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not a real calendar date/);
  });

  it("a valid NPI the history does not contain is an error, not an empty answer", async () => {
    const npi = `123456789${npiCheckDigit("123456789")}`;
    const res = await t.call("lookup_provider", { npi });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(new RegExp(`NPI ${npi} is not in the NPPES history`));
  });
});

describe("npiCheckDigit", () => {
  it("matches published NPIs (Luhn over 80840 + the first nine digits)", () => {
    for (const npi of ["1497859649", "1932213600", "1033218128", "1003215880", "1801771704", "1234567893"]) {
      expect(npiCheckDigit(npi.slice(0, 9)), npi).toBe(Number(npi[9]));
    }
  });
});
