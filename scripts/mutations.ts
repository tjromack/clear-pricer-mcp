// The mutation catalogue: each entry plants one realistic bug, as an exact source edit. scripts/mutate.ts applies
// each in turn, type-checks it (a mutant that does not compile proves nothing), runs every suite, and records which
// tests killed it. A mutant that survives means a test is missing; it gets a test before the milestone closes.

export interface Mutation {
  id: string;
  tool: string;
  bug: string;
  file: string;
  /** Each `find` must occur exactly once in the file. */
  edits: { find: string; replace: string }[];
}

export const MUTATIONS: Mutation[] = [
  // --- compare_code_prices ---------------------------------------------------------------------------------------
  {
    id: "CMP-1",
    tool: "compare_code_prices",
    bug: "Averages a hospital's rows across settings into one row (crosses the agg_code_prices grain)",
    file: "src/tools/compare_code_prices.ts",
    edits: [
      {
        find: "`SELECT * FROM agg_code_prices WHERE code = $code ORDER BY hospital_id, setting, rate_basis`",
        replace:
          "`SELECT hospital_id, code_family, code, 'outpatient' AS setting, rate_basis, sum(charge_rows) AS charge_rows, " +
          "max(payer_plans) AS payer_plans, min(rate_min) AS rate_min, avg(rate_p25) AS rate_p25, avg(rate_median) AS rate_median, " +
          "avg(rate_p75) AS rate_p75, max(rate_max) AS rate_max, avg(gross_median) AS gross_median, avg(cash_median) AS cash_median, " +
          "min(example_description) AS example_description FROM agg_code_prices WHERE code = $code GROUP BY ALL ORDER BY hospital_id, rate_basis`",
      },
    ],
  },
  {
    id: "CMP-2",
    tool: "compare_code_prices",
    bug: "Ignores the rate basis, mixing contracted dollars with percent-derived rows",
    file: "src/tools/compare_code_prices.ts",
    edits: [{ find: `str(r["rate_basis"]) === input.rate_basis &&`, replace: "true &&" }],
  },
  {
    id: "CMP-3",
    tool: "compare_code_prices",
    bug: "Silently drops the hospitals that publish the code another way (empty not_included)",
    file: "src/tools/compare_code_prices.ts",
    edits: [{ find: ".filter((h: HospitalSource) => !prices.some((p) => p.hospital_id === h.hospital_id))", replace: ".filter((_h: HospitalSource) => false)" }],
  },
  {
    id: "CMP-4",
    tool: "compare_code_prices",
    bug: "Returns an empty price list as success when nothing matches",
    file: "src/tools/compare_code_prices.ts",
    edits: [{ find: "if (prices.length === 0) {", replace: "if (prices.length < 0) {" }],
  },
  {
    id: "CMP-5",
    tool: "compare_code_prices",
    bug: "Cites the wrong hospital's source file in provenance",
    file: "src/tools/compare_code_prices.ts",
    edits: [{ find: `const source = hospitals.get(str(r["hospital_id"]));`, replace: "const source = [...hospitals.values()][0];" }],
  },

  // --- get_payer_rates ---------------------------------------------------------------------------------------------
  {
    id: "PAY-1",
    tool: "get_payer_rates",
    bug: "Joins charges to codes instead of a semi-join, and counts rows (the 3.07x fan-out)",
    file: "src/tools/get_payer_rates.ts",
    edits: [
      {
        find: "`SELECT count(DISTINCT c.charge_id) AS n FROM fct_standard_charges c WHERE ${where.join(\" AND \")}`",
        replace:
          "`SELECT count(*) AS n FROM fct_standard_charges c JOIN dim_charge_codes d ON d.item_id = c.item_id WHERE ${where.join(\" AND \")}`",
      },
      {
        find: "`SELECT c.* FROM fct_standard_charges c WHERE ${where.join(\" AND \")}",
        replace: "`SELECT c.* FROM fct_standard_charges c JOIN dim_charge_codes d ON d.item_id = c.item_id WHERE ${where.join(\" AND \")}",
      },
    ],
  },
  {
    id: "PAY-2",
    tool: "get_payer_rates",
    bug: "Derives the code family from code_family alone (MS-DRGs find no charges)",
    file: "src/tools/get_payer_rates.ts",
    edits: [{ find: "AND coalesce(code_family, declared_type) = $family", replace: "AND code_family = $family" }],
  },
  {
    id: "PAY-3",
    tool: "get_payer_rates",
    bug: "Drops the MS-DRG qualifying rule",
    file: "src/tools/get_payer_rates.ts",
    edits: [{ find: "\n          OR declared_type = 'MS-DRG')`;", replace: ")`;" }],
  },
  {
    id: "PAY-4",
    tool: "get_payer_rates",
    bug: "Ignores the row limit",
    file: "src/tools/get_payer_rates.ts",
    edits: [{ find: "      LIMIT $limit`,", replace: "      `," }],
  },
  {
    id: "PAY-5",
    tool: "get_payer_rates",
    bug: "Returns zero matching charges as success",
    file: "src/tools/get_payer_rates.ts",
    edits: [{ find: "if (matched === 0) {", replace: "if (matched < 0) {" }],
  },
  {
    id: "PAY-6",
    tool: "get_payer_rates",
    bug: "Applies the payer filter to the per-setting breakdown too (breakdown no longer reconciles to charge_rows)",
    file: "src/tools/get_payer_rates.ts",
    edits: [
      { find: "  const breakdown = await db.query(", replace: "  if (input.payer) where.push(\"contains(lower(c.payer_name), $payer)\"), (params[\"payer\"] = input.payer.toLowerCase());\n  const breakdown = await db.query(" },
      { find: "  if (input.payer) {\n    where.push(\"contains(lower(c.payer_name), $payer)\");\n    params[\"payer\"] = input.payer.toLowerCase();\n  }", replace: "" },
    ],
  },

  // --- find_codes ----------------------------------------------------------------------------------------------------
  {
    id: "FND-1",
    tool: "find_codes",
    bug: "Matches any search word instead of every word",
    file: "src/tools/find_codes.ts",
    edits: [{ find: '.map((_, i) => `contains(lower(example_description), $w${i})`).join(" AND ")', replace: '.map((_, i) => `contains(lower(example_description), $w${i})`).join(" OR ")' }],
  },
  {
    id: "FND-2",
    tool: "find_codes",
    bug: "Counts agg rows instead of summing charge_rows (charges per code wrong)",
    file: "src/tools/find_codes.ts",
    edits: [{ find: "sum(a.charge_rows) AS charges,", replace: "count(*) AS charges," }],
  },
  {
    id: "FND-3",
    tool: "find_codes",
    bug: "Returns an empty result as success when nothing matches",
    file: "src/tools/find_codes.ts",
    edits: [{ find: "if (rows.length === 0) {", replace: "if (rows.length < 0) {" }],
  },
  {
    id: "FND-4",
    tool: "find_codes",
    bug: "Marks every description as matched (hides single-hospital matches)",
    file: "src/tools/find_codes.ts",
    edits: [{ find: "matched: matchesAll(d.description, words),", replace: "matched: true," }],
  },

  // --- lookup_provider ---------------------------------------------------------------------------------------------
  {
    id: "NPI-1",
    tool: "lookup_provider",
    bug: "Treats valid_to as inclusive (closed intervals: two versions valid on the boundary day)",
    file: "src/tools/lookup_provider.ts",
    edits: [{ find: `(input.as_of ?? "") < str(v["vt"])`, replace: `(input.as_of ?? "") <= str(v["vt"])` }],
  },
  {
    id: "NPI-2",
    tool: "lookup_provider",
    bug: "Skips the NPI check digit",
    file: "src/tools/lookup_provider.ts",
    edits: [{ find: "if (Number(npi[9]) !== expected) {", replace: "if (Number(npi[9]) !== expected && false) {" }],
  },
  {
    id: "NPI-3",
    tool: "lookup_provider",
    bug: "Ignores the as-of date and returns the current registration",
    file: "src/tools/lookup_provider.ts",
    // A "latest version starting on or before the date" mutant was tried and dropped: the history has no gaps between
    // versions (check_values derived.provider_history_gaps_between_versions = 0), so it is equivalent, not a bug.
    edits: [{ find: "const pick = input.as_of\n    ? versions.find(", replace: "const pick = input.as_of && false\n    ? versions.find(" }],
  },

  // --- data_quality --------------------------------------------------------------------------------------------------
  {
    id: "DQ-1",
    tool: "data_quality",
    bug: "Sums the whole reconciliation table, adding the ALL row to the hospital rows",
    file: "src/tools/data_quality.ts",
    edits: [{ find: "overall: reconciliation(overall),", replace: "overall: { ...reconciliation(overall), disclosed_npis: recon.reduce((s, r) => s + int(r[\"disclosed_npis\"]), 0) }," }],
  },

  // --- release integrity ---------------------------------------------------------------------------------------------
  {
    id: "REL-1",
    tool: "release",
    bug: "Serves a downloaded file without checking its SHA-256",
    file: "src/release.ts",
    edits: [{ find: "if (actual !== expected) {", replace: "if (actual !== expected && false) {" }],
  },
  {
    id: "REL-2",
    tool: "release",
    bug: "Trusts a cached file without re-hashing it",
    file: "src/release.ts",
    edits: [{ find: "if (sha256(cached) === expected) {", replace: "if (cached.length > 0) {" }],
  },
  {
    id: "REL-3",
    tool: "release",
    bug: "Accepts a release tag without its manifest hash",
    file: "src/release.ts",
    edits: [
      { find: "if (tag === undefined || sha === undefined || !SHA256_HEX.test(sha)) {", replace: "if (tag === undefined) {" },
      { find: "return { tag, manifestSha256: sha };", replace: "return { tag, manifestSha256: sha ?? \"\" };" },
    ],
  },
  {
    id: "REL-4",
    tool: "release",
    bug: "Reads the remote provider history without the footer row-count check",
    file: "src/db.ts",
    edits: [{ find: "if (rows !== remote.rows) {", replace: "if (rows !== remote.rows && false) {" }],
  },
  {
    id: "REL-5",
    tool: "release",
    bug: "Converts an out-of-range BIGINT to a lossy number",
    file: "src/db.ts",
    edits: [{ find: "if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {", replace: "if (false) {" }],
  },
];
