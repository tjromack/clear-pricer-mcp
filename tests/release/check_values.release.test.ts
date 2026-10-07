// The downloaded release recomputed against its own check_values.json, at full scale. npm run test:release
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db, int } from "../../src/db.js";
import { Release, type CheckValues } from "../../src/release.js";
import { QUALIFYING_ITEMS } from "../../src/tools/get_payer_rates.js";

let db: Db;
let cv: CheckValues;
beforeAll(async () => {
  db = await Db.open(Release.fromEnv({ ...process.env, CLEAR_PRICER_RELEASE: undefined, CLEAR_PRICER_MANIFEST_SHA256: undefined }));
  cv = await db.release.checkValues();
});
afterAll(() => db.close());

const derived = (k: string): number => {
  const v = cv.derived[k];
  if (v === undefined) throw new Error(`check_values.derived.${k} missing`);
  return v;
};

describe("fan-out at full scale", () => {
  it("joining charges to codes multiplies 7,371,416 charges into 22,647,893 rows (3.07x): the trap is real", async () => {
    const [r] = await db.query(
      ["fct_standard_charges", "dim_charge_codes"],
      `SELECT (SELECT count(*) FROM fct_standard_charges) AS charges,
              (SELECT count(*) FROM fct_standard_charges c JOIN dim_charge_codes d USING (item_id)) AS joined`,
    );
    expect(int(r?.["charges"])).toBe(derived("charges"));
    expect(int(r?.["joined"])).toBe(derived("charge_x_code_rows"));
    expect(Math.round((int(r?.["joined"]) / int(r?.["charges"])) * 1e4) / 1e4).toBe(derived("charges_to_codes_fanout"));
  });

  it("the tools' semi-join over qualifying items covers exactly the charges agg_code_prices covers", async () => {
    // QUALIFYING_ITEMS is parameterised per code; this applies the same predicate to every code at once.
    const predicate = QUALIFYING_ITEMS.slice(QUALIFYING_ITEMS.indexOf("AND (code_family IN"));
    const [r] = await db.query(
      ["fct_standard_charges", "dim_charge_codes"],
      `SELECT count(DISTINCT charge_id) AS n FROM fct_standard_charges
        WHERE item_id IN (SELECT item_id FROM dim_charge_codes WHERE true ${predicate})`,
    );
    expect(int(r?.["n"])).toBe(derived("agg_code_prices_charges_covered"));
  });
});

describe("money checksums (integer cents, order-independent)", () => {
  it("negotiated_rate and gross_charge sum to the published checksums", async () => {
    const [r] = await db.query(
      ["fct_standard_charges"],
      `SELECT sum(round(negotiated_rate * 100))::HUGEINT AS rate, sum(round(gross_charge * 100))::HUGEINT AS gross
         FROM fct_standard_charges`,
    );
    expect(Number(r?.["rate"])).toBe(derived("negotiated_rate_sum_cents"));
    expect(Number(r?.["gross"])).toBe(derived("gross_charge_sum_cents"));
  });
});

describe("every downloaded table matches its row count and proved key", () => {
  for (const table of [
    "agg_code_prices",
    "files",
    "dim_charge_codes",
    "fct_standard_charges",
    "rpt_npi_reconciliation",
    "rpt_npi_resolution",
    "rpt_source_conformance",
  ] as const) {
    it(table, async () => {
      const spec = cv.tables[table];
      if (!spec) throw new Error(`check_values has no entry for ${table}`);
      const key = spec.key.map((c) => `"${c}"`).join(", ");
      const [r] = await db.query([table], `SELECT count(*) AS n, count(DISTINCT (${key})) AS k FROM ${table}`);
      expect(int(r?.["n"])).toBe(spec.rows);
      expect(int(r?.["k"])).toBe(spec.distinct_keys);
    });
  }
});

describe("the remote provider history", () => {
  it("its footer row count is what the manifest and check_values promise", async () => {
    const [r] = await db.query(["dim_provider_history"], "SELECT count(*) AS n FROM dim_provider_history");
    expect(int(r?.["n"])).toBe(cv.tables["dim_provider_history"]?.rows);
  });
});
