// Against the real pinned release (network on first run, then the OS cache). npm run test:release
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { int, numOrNull, str } from "../../src/db.js";
import { Release } from "../../src/release.js";
import { connect, text, type Connected } from "../helpers.js";

let t: Connected;
beforeAll(async () => {
  t = await connect(Release.fromEnv({ ...process.env, CLEAR_PRICER_RELEASE: undefined, CLEAR_PRICER_MANIFEST_SHA256: undefined }));
});
afterAll(async () => t.close());

describe("against the pinned release", () => {
  it("release_info verifies the manifest and check values of the default pin", async () => {
    const res = await t.call("release_info");
    expect(res.isError, text(res)).toBeFalsy();
    const out = res.structuredContent as { release_tag: string; check_values_verified: boolean; files: { file: string }[] };
    expect(out.release_tag).toBe("data-2026-10-07-67efd3d2");
    expect(out.check_values_verified).toBe(true);
    expect(out.files).toHaveLength(15);
  });

  it("the downloaded agg_code_prices matches check_values.json (rows and proved key)", async () => {
    const cv = (await t.db.release.checkValues()).tables["agg_code_prices"];
    const [r] = await t.db.query(
      ["agg_code_prices"],
      `SELECT count(*) AS n,
              count(DISTINCT (hospital_id, code_family, code, setting, rate_basis)) AS k
         FROM agg_code_prices`,
    );
    expect(int(r?.["n"])).toBe(cv?.rows);
    expect(int(r?.["k"])).toBe(cv?.distinct_keys);
  });

  it("99213 matches the release row for row, with Northwestern reported as not publishing contracted dollars", async () => {
    const res = await t.call("compare_code_prices", { code: "99213" });
    expect(res.isError, text(res)).toBeFalsy();
    const out = res.structuredContent as {
      prices: { hospital_id: string; setting: string; charge_rows: number; rate_median: number | null }[];
      not_included: { hospital_id: string }[];
    };
    const raw = await t.db.query(
      ["agg_code_prices"],
      `SELECT hospital_id, setting, charge_rows, rate_median FROM agg_code_prices
        WHERE code = '99213' AND rate_basis = 'dollar' ORDER BY hospital_id, setting`,
    );
    expect(out.prices.map((p) => [p.hospital_id, p.setting, p.charge_rows, p.rate_median])).toEqual(
      raw.map((r) => [str(r["hospital_id"]), str(r["setting"]), int(r["charge_rows"]), numOrNull(r["rate_median"])]),
    );
    expect(out.prices.map((p) => p.hospital_id)).toEqual(["rush", "uchicago"]);
    expect(out.not_included.map((h) => h.hospital_id)).toEqual(["nm"]);
  });
});
