import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchWords } from "../../src/tools/find_codes.js";
import { connect, text, type Connected } from "../helpers.js";

interface Out {
  matched_words: string[];
  results: {
    code: string;
    code_family: string;
    hospital_ids: string[];
    charges: number;
    descriptions: { hospital_id: string; description: string; matched: boolean; source_filename: string }[];
  }[];
  truncated: boolean;
  notes: string[];
}

let t: Connected;
beforeAll(async () => {
  t = await connect();
});
afterAll(async () => t.close());

async function find(args: Record<string, unknown>): Promise<Out> {
  const res = await t.call("find_codes", args);
  expect(res.isError, text(res)).toBeFalsy();
  return res.structuredContent as unknown as Out;
}

describe("find_codes — contract", () => {
  it("finds codes from words in the hospitals' own descriptions", async () => {
    const out = await find({ query: "MRI brain" });
    expect(out.matched_words).toEqual(["mri", "brain"]);
    expect(out.results.map((r) => r.code)).toEqual(["70553"]);
    expect(out.results[0]?.descriptions.every((d) => /mri/i.test(d.description) && d.source_filename.length > 0)).toBe(true);
  });

  it("requires every word, ignoring filler words and case", async () => {
    const out = await find({ query: "the cost of an MRI" });
    expect(out.matched_words).toEqual(["mri"]);
    // 10011 is a needle biopsy "with MRI guidance": a correct match on the word, which is the point of showing descriptions.
    expect(out.results.map((r) => r.code).sort()).toEqual(["10011", "70553", "73721"]);
    for (const r of out.results) expect(r.descriptions.some((d) => /mri/i.test(d.description)), r.code).toBe(true);
  });

  it("marks which hospitals' descriptions matched, and warns when the match rests on some of them only", async () => {
    // 70553: Rush and UChicago say "contrast"; Northwestern says "W/O & W/Dye".
    const out = await find({ query: "contrast" });
    const mri = out.results.find((r) => r.code === "70553");
    expect(mri?.descriptions.filter((d) => d.matched).map((d) => d.hospital_id).sort()).toEqual(["rush", "uchicago"]);
    expect(mri?.descriptions[0]?.matched).toBe(true); // matching descriptions first
    expect(out.notes.join("\n")).toMatch(/70553 matched only in the description from rush, uchicago; nm describes it differently/);
  });

  it("puts an exact code match first", async () => {
    const out = await find({ query: "j1885" });
    expect(out.results[0]?.code).toBe("J1885");
    expect(out.notes.join("\n")).toMatch(/matched a code exactly/);
  });

  it("counts a code's charges once each (sum of charge_rows across settings and bases)", async () => {
    const out = await find({ query: "99213" });
    const [raw] = await t.db.query(["agg_code_prices"], "SELECT sum(charge_rows) AS n FROM agg_code_prices WHERE code = '99213'");
    expect(out.results[0]?.charges).toBe(Number(raw?.["n"]));
  });

  it("filters by hospital and code family", async () => {
    expect((await find({ query: "10011", hospital_id: "uchicago" })).results.map((r) => r.code)).toEqual(["10011"]);
    const res = await t.call("find_codes", { query: "10011", hospital_id: "rush" });
    expect(res.isError).toBe(true);
    const drg = await find({ query: "470", code_family: "MS-DRG" });
    expect(drg.results.every((r) => r.code_family === "MS-DRG")).toBe(true);
  });

  it("orders by how many hospitals publish the code, and truncates at the limit", async () => {
    const out = await find({ query: "mri", limit: 2 });
    expect(out.results.map((r) => r.code)).toEqual(["70553", "73721"]); // three hospitals each, ahead of 10011's one
    expect(out.truncated).toBe(true);
  });

  it("never returns an empty result: no match is an error with search advice", async () => {
    const res = await t.call("find_codes", { query: "teleportation" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/No billing code .* 'teleportation'/s);
    expect(text(res)).toMatch(/abbreviations/);
  });
});

describe("searchWords", () => {
  it("keeps slashes hospitals use in abbreviations and drops stopwords", () => {
    expect(searchWords("MRI knee W/O contrast, of the")).toEqual(["mri", "knee", "w/o", "contrast"]);
  });
});
