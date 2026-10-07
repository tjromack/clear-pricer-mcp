// Against the real pinned release (network on first run, then the OS cache). npm run test:release
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { int, str, type TableName } from "../../src/db.js";
import { Release } from "../../src/release.js";
import { CODE_FAMILIES, HOSPITAL_IDS, RATE_BASES, SETTINGS } from "../../src/vocab.js";
import { connect, text, type Connected } from "../helpers.js";

let t: Connected;
beforeAll(async () => {
  t = await connect(Release.fromEnv({ ...process.env, CLEAR_PRICER_RELEASE: undefined, CLEAR_PRICER_MANIFEST_SHA256: undefined }));
});
afterAll(async () => t.close());

const distinct = async (table: TableName, col: string): Promise<string[]> =>
  (await t.db.query([table], `SELECT DISTINCT ${col} AS v FROM ${table} ORDER BY 1`)).map((r) => str(r["v"]));

describe("vocabulary matches the release", () => {
  it("hospitals, settings, rate bases and code families are exactly the release's values", async () => {
    expect(await distinct("files", "hospital_id")).toEqual([...HOSPITAL_IDS].sort());
    expect(await distinct("agg_code_prices", "setting")).toEqual([...SETTINGS].sort());
    expect(await distinct("agg_code_prices", "rate_basis")).toEqual([...RATE_BASES].sort());
    expect(await distinct("agg_code_prices", "code_family")).toEqual([...CODE_FAMILIES].sort());
  });
});

describe("get_payer_rates against the whole release", () => {
  it("its charge selection reproduces every agg_code_prices.charge_rows (49,404 rows)", async () => {
    // The same item definition get_payer_rates uses (QUALIFYING_ITEMS), applied to every hospital × code at once.
    const [r] = await t.db.query(
      ["agg_code_prices", "fct_standard_charges", "dim_charge_codes"],
      `WITH items AS (
         SELECT DISTINCT hospital_id, item_id, code, coalesce(code_family, declared_type) AS code_family
           FROM dim_charge_codes
          WHERE code_family IN ('CPT_CAT_I', 'CPT_CAT_II', 'CPT_CAT_III', 'CPT_PLA', 'CPT_MAAA', 'HCPCS_II', 'CDT')
             OR declared_type = 'MS-DRG'),
       mine AS (
         SELECT i.hospital_id, i.code_family, i.code, c.setting, c.rate_basis, count(DISTINCT c.charge_id) AS n
           FROM items i JOIN fct_standard_charges c ON c.item_id = i.item_id AND c.hospital_id = i.hospital_id
          GROUP BY ALL)
       SELECT count(*) AS compared,
              count(*) FILTER (WHERE m.n IS DISTINCT FROM a.charge_rows) AS mismatched
         FROM mine m FULL JOIN agg_code_prices a USING (hospital_id, code_family, code, setting, rate_basis)`,
    );
    expect(int(r?.["compared"])).toBe((await t.db.release.checkValues()).tables["agg_code_prices"]?.rows);
    expect(int(r?.["mismatched"])).toBe(0);
  });

  it("an MS-DRG resolves to its charges (family comes from declared_type)", async () => {
    const res = await t.call("get_payer_rates", { code: "470", hospital_id: "rush" });
    expect(res.isError, text(res)).toBeFalsy();
    const out = res.structuredContent as { matched_charges: number; code_family: string };
    expect(out.code_family).toBe("MS-DRG");
    expect(out.matched_charges).toBeGreaterThan(0);
  });

  it("Northwestern 99213: 282 charges, none fanned out", async () => {
    const res = await t.call("get_payer_rates", { code: "99213", hospital_id: "nm", limit: 200 });
    const out = res.structuredContent as { matched_charges: number; by_setting_and_basis: { charges: number }[] };
    expect(out.matched_charges).toBe(282);
    expect(out.by_setting_and_basis.reduce((s, b) => s + b.charges, 0)).toBe(282);
  });
});

describe("the other tools against the release", () => {
  it("find_codes finds the brain MRI code from plain words", async () => {
    const res = await t.call("find_codes", { query: "mri brain" });
    expect(res.isError, text(res)).toBeFalsy();
    const out = res.structuredContent as { results: { code: string }[] };
    expect(out.results.map((r) => r.code)).toContain("70553");
  });

  it("lookup_provider answers the as-of example from clear-pricer's grain.md", async () => {
    const res = await t.call("lookup_provider", { npi: "1497859649", as_of: "2026-07-16" });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ name: "NORTHWESTERN MEMORIAL HOSPITAL", version: 1, status: "active" });
  });

  it("lookup_provider never returns the zero-length version check_values counts", async () => {
    expect((await t.db.release.checkValues()).derived["provider_history_zero_length_versions"]).toBe(1);
    const res = await t.call("lookup_provider", { npi: "1801771704", as_of: "2026-09-14" });
    expect(res.structuredContent).toMatchObject({ version: 2 });
  });

  it("data_quality's overall row equals check_values' published headline", async () => {
    const res = await t.call("data_quality");
    const out = res.structuredContent as { overall: { unresolved_rate: number; disclosure_coverage: number } };
    const cv = (await t.db.release.checkValues()).derived;
    expect(out.overall.unresolved_rate).toBe(cv["npi_unresolved_rate_all"]);
    expect(out.overall.disclosure_coverage).toBe(cv["npi_disclosure_coverage_all"]);
  });
});
