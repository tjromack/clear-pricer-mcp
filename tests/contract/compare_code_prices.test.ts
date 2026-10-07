import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { int, numOrNull, str } from "../../src/db.js";
import { FIXTURE_PIN } from "../fixtures/pin.js";
import { connect, text, type Connected } from "../helpers.js";

interface Price {
  hospital_id: string;
  setting: string;
  rate_basis: string;
  charge_rows: number;
  rate_median: number | null;
  rate_min: number | null;
  rate_max: number | null;
  provenance: Record<string, string>;
}
interface Out {
  code: string;
  rate_basis: string;
  prices: Price[];
  not_included: { hospital_id: string; published: { setting: string; rate_basis: string; charge_rows: number }[] }[];
  notes: string[];
}

let t: Connected;
beforeAll(async () => {
  t = await connect();
});
afterAll(async () => t.close());

async function compare(args: Record<string, unknown>): Promise<Out> {
  const res = await t.call("compare_code_prices", args);
  expect(res.isError, text(res)).toBeFalsy();
  return res.structuredContent as unknown as Out;
}

describe("compare_code_prices — contract", () => {
  it("defaults to contracted dollars and names the hospital that publishes the code another way", async () => {
    const out = await compare({ code: "99213" });
    expect(out.rate_basis).toBe("dollar");
    expect(out.prices.map((p) => p.hospital_id)).toEqual(["rush", "uchicago"]);
    expect(out.prices.find((p) => p.hospital_id === "rush")?.rate_median).toBe(185);
    expect(out.prices.find((p) => p.hospital_id === "uchicago")?.rate_median).toBe(61.65);

    const nm = out.not_included.find((h) => h.hospital_id === "nm");
    expect(nm?.published).toContainEqual(
      expect.objectContaining({ setting: "outpatient", rate_basis: "dollar_from_percent", charge_rows: 276 }),
    );
    expect(out.notes.join("\n")).toMatch(/Northwestern .* publishes this code, but not under rate_basis 'dollar'/s);
  });

  it("cites the hospital's own source file on every row", async () => {
    const out = await compare({ code: "12002" });
    const files = await t.db.query(["files"], "SELECT * FROM files");
    for (const p of out.prices) {
      const f = files.find((r) => str(r["hospital_id"]) === p.hospital_id);
      expect(p.provenance).toEqual({
        release_tag: FIXTURE_PIN.tag,
        table: "agg_code_prices",
        hospital_id: p.hospital_id,
        hospital_name: str(f?.["hospital_name"]),
        source_filename: str(f?.["source_filename"]),
        source_sha256: str(f?.["source_sha256"]),
        source_last_updated_on: str(f?.["last_updated_on"]),
      });
    }
  });

  it("returns table rows as published: one per hospital × setting, never combined", async () => {
    // 12002 has Rush rows in two settings; they must come back as two rows, not one averaged row.
    const out = await compare({ code: "12002" });
    const keys = out.prices.map((p) => `${p.hospital_id}/${p.setting}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["rush/both", "rush/outpatient", "uchicago/outpatient"]);
    expect(out.notes.join("\n")).toMatch(/more than one setting/);

    const raw = await t.db.query(
      ["agg_code_prices"],
      "SELECT * FROM agg_code_prices WHERE code = '12002' AND rate_basis = 'dollar' ORDER BY hospital_id, setting",
    );
    expect(out.prices.map((p) => [p.charge_rows, p.rate_min, p.rate_median, p.rate_max])).toEqual(
      raw.map((r) => [int(r["charge_rows"]), numOrNull(r["rate_min"]), numOrNull(r["rate_median"]), numOrNull(r["rate_max"])]),
    );
  });

  it("filters to one setting when asked", async () => {
    const out = await compare({ code: "12002", setting: "outpatient" });
    expect(out.prices.map((p) => p.setting)).toEqual(["outpatient", "outpatient"]);
  });

  it("includes a hospital once the caller asks for the basis it publishes", async () => {
    const out = await compare({ code: "99213", rate_basis: "dollar_from_percent" });
    expect(out.prices.map((p) => p.hospital_id)).toEqual(["nm", "rush"]);
  });

  it("says plainly when a rate basis carries no dollar figure", async () => {
    const out = await compare({ code: "470", rate_basis: "percent_only" });
    expect(out.prices.every((p) => p.rate_median === null)).toBe(true);
    expect(out.notes.join("\n")).toMatch(/no dollar rate/);
  });

  it("lists a hospital that does not publish the code at all with nothing published", async () => {
    const out = await compare({ code: "10011" });
    expect(out.prices.map((p) => p.hospital_id)).toEqual(["uchicago"]);
    expect(out.not_included.map((h) => [h.hospital_id, h.published.length])).toEqual([
      ["nm", 0],
      ["rush", 0],
    ]);
  });

  it("normalises case and whitespace in the code", async () => {
    const out = await compare({ code: "  j1885 " });
    expect(out.code).toBe("J1885");
    expect(out.prices.length).toBeGreaterThan(0);
  });
});

describe("compare_code_prices — fails loudly, never empty", () => {
  it("an unknown code is an error that points to find_codes", async () => {
    const res = await t.call("compare_code_prices", { code: "00000" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not priced in any hospital's file/);
    expect(text(res)).toMatch(/find_codes/);
  });

  it("a filter nothing matches is an error listing what each hospital does publish", async () => {
    const res = await t.call("compare_code_prices", { code: "99213", setting: "inpatient" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/No hospital publishes code 99213 under rate_basis 'dollar' and setting 'inpatient'/);
    expect(text(res)).toMatch(/RUSH University Medical Center \(rush\): outpatient \/ dollar: 30 charge rows/);
  });

  it("an invalid rate basis is rejected by the input schema", async () => {
    const res = await t.call("compare_code_prices", { code: "99213", rate_basis: "average" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Input validation error/);
  });
});
