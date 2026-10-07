import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { int, str } from "../../src/db.js";
import { connect, text, type Connected } from "../helpers.js";

interface Out {
  code_family: string;
  matched_charges: number;
  returned: number;
  truncated: boolean;
  by_setting_and_basis: { setting: string; rate_basis: string; charges: number }[];
  rates: {
    payer_name: string | null;
    setting: string;
    rate_basis: string;
    negotiated_rate: number | null;
    provenance: { source_locator: string; table: string; hospital_id: string; source_sha256: string };
  }[];
  notes: string[];
}

let t: Connected;
beforeAll(async () => {
  t = await connect();
});
afterAll(async () => t.close());

async function rates(args: Record<string, unknown>): Promise<Out> {
  const res = await t.call("get_payer_rates", args);
  expect(res.isError, text(res)).toBeFalsy();
  return res.structuredContent as unknown as Out;
}

describe("get_payer_rates — grain", () => {
  it("counts each charge once: per setting × basis it equals agg_code_prices.charge_rows", async () => {
    for (const hospital_id of ["nm", "rush", "uchicago"] as const) {
      for (const code of ["99213", "J1885", "12002", "470"]) {
        const res = await t.call("get_payer_rates", { code, hospital_id });
        const agg = await t.db.query(
          ["agg_code_prices"],
          `SELECT setting, rate_basis, charge_rows FROM agg_code_prices
            WHERE code = $code AND hospital_id = $h ORDER BY setting, rate_basis`,
          { code, h: hospital_id },
        );
        if (agg.length === 0) {
          expect(res.isError, `${code}@${hospital_id}`).toBe(true);
          continue;
        }
        const out = res.structuredContent as unknown as Out;
        expect(out.by_setting_and_basis, `${code}@${hospital_id}`).toEqual(
          agg.map((r) => ({ setting: str(r["setting"]), rate_basis: str(r["rate_basis"]), charges: int(r["charge_rows"]) })),
        );
        expect(out.matched_charges).toBe(out.by_setting_and_basis.reduce((s, b) => s + b.charges, 0));
      }
    }
  });

  it("does not fan out: a naive charges-to-codes join would return more rows than there are charges", async () => {
    const out = await rates({ code: "99213", hospital_id: "nm", limit: 200 });
    const [naive] = await t.db.query(
      ["fct_standard_charges", "dim_charge_codes"],
      `SELECT count(*) AS n FROM fct_standard_charges c JOIN dim_charge_codes d USING (item_id)
        WHERE c.hospital_id = 'nm' AND c.item_id IN (SELECT item_id FROM dim_charge_codes WHERE code = '99213')`,
    );
    expect(int(naive?.["n"])).toBeGreaterThan(out.matched_charges); // the trap is real in this data
    expect(out.matched_charges).toBe(282); // 276 dollar_from_percent + 6 algorithm_only
    const locators = out.rates.map((r) => r.provenance.source_locator);
    expect(new Set(locators).size).toBe(locators.length);
  });
});

describe("get_payer_rates — contract", () => {
  it("labels every row with its basis and cites its position in the hospital's file", async () => {
    const out = await rates({ code: "99213", hospital_id: "rush" });
    expect(out.rates.length).toBe(out.returned);
    for (const r of out.rates) {
      expect(r.provenance.table).toBe("fct_standard_charges");
      expect(r.provenance.hospital_id).toBe("rush");
      expect(r.provenance.source_locator).toMatch(/^r\d+$/);
      expect(["dollar", "dollar_from_percent"]).toContain(r.rate_basis);
    }
  });

  it("filters by rate basis, setting and payer", async () => {
    const out = await rates({ code: "99213", hospital_id: "rush", rate_basis: "dollar", setting: "outpatient" });
    expect(out.matched_charges).toBe(30);
    expect(out.rates.every((r) => r.rate_basis === "dollar" && r.setting === "outpatient")).toBe(true);
    const payer = out.rates[0]?.payer_name ?? "";
    const one = await rates({ code: "99213", hospital_id: "rush", payer: payer.slice(0, 6).toLowerCase() });
    expect(one.rates.every((r) => (r.payer_name ?? "").toLowerCase().includes(payer.slice(0, 6).toLowerCase()))).toBe(true);
  });

  it("keeps rows the hospital published twice, each cited at its own file position, and says so", async () => {
    const out = await rates({ code: "99213", hospital_id: "rush", limit: 200 });
    const locators = out.rates.map((r) => r.provenance.source_locator);
    expect(new Set(locators).size).toBe(locators.length);
    expect(out.notes.join("\n")).toMatch(/repeat another row's published values at a different position/);
  });

  it("truncates at the limit and says so", async () => {
    const out = await rates({ code: "J1885", hospital_id: "nm", limit: 5 });
    expect(out.returned).toBe(5);
    expect(out.truncated).toBe(true);
    expect(out.notes.join("\n")).toMatch(/Showing 5 of/);
  });

  it("explains rows without a dollar figure", async () => {
    const out = await rates({ code: "99213", hospital_id: "nm", rate_basis: "algorithm_only" });
    expect(out.rates.every((r) => r.negotiated_rate === null)).toBe(true);
    expect(out.notes.join("\n")).toMatch(/percentage or an algorithm/);
  });
});

describe("get_payer_rates — fails loudly", () => {
  it("a code the hospital does not publish names the hospitals that do", async () => {
    const res = await t.call("get_payer_rates", { code: "10011", hospital_id: "rush" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/rush does not publish a price for code 10011/);
    expect(text(res)).toMatch(/published by: uchicago/);
  });

  it("filters that exclude everything list what exists, including payer names", async () => {
    const res = await t.call("get_payer_rates", { code: "99213", hospital_id: "rush", payer: "zzz-no-such-payer" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/outpatient \/ dollar: 30 charge rows/);
    expect(text(res)).toMatch(/payers: /);
  });

  it("rejects an unknown hospital id at the schema", async () => {
    const res = await t.call("get_payer_rates", { code: "99213", hospital_id: "mayo" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Input validation error/);
  });
});
