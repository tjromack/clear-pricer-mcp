import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBValue } from "@duckdb/node-api";
import { z } from "zod";
import { int, numOrNull, str, strOrNull, type Db } from "../db.js";
import { NoMatchError } from "../errors.js";
import { hospitalSources, provenance, provenanceSchema } from "../provenance.js";
import {
  RATE_BASES,
  RATE_BASIS_HELP,
  SETTINGS,
  hospitalIdSchema,
  normaliseCode,
  rateBasisSchema,
  settingSchema,
  type HospitalId,
  type RateBasis,
  type Setting,
} from "../vocab.js";

const ALGORITHM_MAX = 300;

export const inputSchema = {
  code: z.string().min(1).max(16).describe("Billing code as published, e.g. 99213. Use find_codes to get one."),
  hospital_id: hospitalIdSchema,
  rate_basis: rateBasisSchema.optional().describe(`${RATE_BASIS_HELP} Omit for every basis (each row is labelled).`),
  setting: settingSchema.optional(),
  payer: z.string().min(2).max(60).optional().describe("Case-insensitive match on payer name, e.g. 'aetna', 'blue cross'"),
  limit: z.number().int().min(1).max(200).default(50),
};

const rateRowSchema = z.object({
  payer_name: z.string().nullable(),
  plan_name: z.string().nullable(),
  setting: z.enum(SETTINGS),
  rate_basis: z.enum(RATE_BASES),
  negotiated_rate: z.number().nullable().describe("The hospital's dollar figure for this payer/plan, when it has one"),
  negotiated_dollar: z.number().nullable(),
  negotiated_percentage: z.number().nullable().describe("Percent of the hospital's gross charge, when published"),
  negotiated_algorithm: z.string().nullable().describe(`Truncated to ${ALGORITHM_MAX} characters`),
  methodology: z.string().nullable(),
  gross_charge: z.number().nullable(),
  discounted_cash: z.number().nullable(),
  billing_class: z.string().nullable(),
  modifiers: z.string().nullable(),
  description: z.string().nullable().describe("The hospital's own description of the item"),
  provenance: provenanceSchema.extend({
    source_locator: z.string().describe("Position of this charge in the hospital's source file"),
  }),
});

export const outputSchema = {
  release_tag: z.string(),
  hospital_id: z.string(),
  code: z.string(),
  code_family: z.string(),
  matched_charges: z.number().int().describe("Distinct charge rows matching every filter"),
  returned: z.number().int(),
  truncated: z.boolean(),
  by_setting_and_basis: z
    .array(z.object({ setting: z.enum(SETTINGS), rate_basis: z.enum(RATE_BASES), charges: z.number().int() }))
    .describe("Distinct charges per setting × rate basis before the payer filter and limit; equals compare_code_prices' charge_rows"),
  rates: z.array(rateRowSchema),
  notes: z.array(z.string()),
};

type Input = {
  code: string;
  hospital_id: HospitalId;
  rate_basis?: RateBasis | undefined;
  setting?: Setting | undefined;
  payer?: string | undefined;
  limit: number;
};
type Output = z.infer<z.ZodObject<typeof outputSchema>>;

// Grain (docs/grain.md in clear-pricer): dim_charge_codes is one-to-many from an item, and an item can list the same
// code twice. Charges are selected by item_id IN (distinct items carrying the code), a semi-join, so a charge appears
// at most once however many codes its item lists. Joining charges to codes directly would fan out 3.07x.
//
// The code's family is derived exactly as clear-pricer's agg_code_prices derives it (dbt/models/marts/
// agg_code_prices.sql): coalesce(code_family, declared_type), for the qualifying families plus MS-DRG, whose rows have
// a NULL code_family and are identified by declared_type alone. Any other definition makes the two tools disagree.
export const QUALIFYING_ITEMS = `SELECT DISTINCT item_id FROM dim_charge_codes
   WHERE code = $code AND coalesce(code_family, declared_type) = $family
     AND (code_family IN ('CPT_CAT_I', 'CPT_CAT_II', 'CPT_CAT_III', 'CPT_PLA', 'CPT_MAAA', 'HCPCS_II', 'CDT')
          OR declared_type = 'MS-DRG')`;
const ITEMS = `${QUALIFYING_ITEMS} AND hospital_id = $hospital`;

export async function getPayerRates(db: Db, input: Input): Promise<Output> {
  const code = normaliseCode(input.code);
  const tag = db.release.pin.tag;

  // Resolve the code at this hospital through agg_code_prices (cheap), before touching the 7.4M-row fact table.
  const published = await db.query(
    ["agg_code_prices"],
    `SELECT hospital_id, code_family, setting, rate_basis, charge_rows FROM agg_code_prices
      WHERE code = $code ORDER BY hospital_id, setting, rate_basis`,
    { code },
  );
  const here = published.filter((r) => str(r["hospital_id"]) === input.hospital_id);
  if (here.length === 0) {
    const elsewhere = [...new Set(published.map((r) => str(r["hospital_id"])))];
    throw new NoMatchError(`${input.hospital_id} does not publish a price for code ${code} in release ${tag}.`, {
      found: elsewhere.length ? [`code ${code} is published by: ${elsewhere.join(", ")}`] : [],
      tryInstead: elsewhere.length
        ? [`get_payer_rates with hospital_id ${elsewhere[0] ?? ""}`, "compare_code_prices to see every hospital at once"]
        : ["find_codes with a description to find the code hospitals actually use"],
    });
  }
  const families = [...new Set(here.map((r) => str(r["code_family"])))];
  if (families.length > 1) {
    throw new NoMatchError(`Code ${code} appears in several code families at ${input.hospital_id}: ${families.join(", ")}.`);
  }
  const family = families[0] ?? "";

  const params: Record<string, DuckDBValue> = { hospital: input.hospital_id, code, family };
  const where = ["c.hospital_id = $hospital", `c.item_id IN (${ITEMS})`];
  if (input.rate_basis) {
    where.push("c.rate_basis = $basis");
    params["basis"] = input.rate_basis;
  }
  if (input.setting) {
    where.push("c.setting = $setting");
    params["setting"] = input.setting;
  }
  const breakdown = await db.query(
    ["fct_standard_charges", "dim_charge_codes"],
    `SELECT c.setting, c.rate_basis, count(DISTINCT c.charge_id) AS charges
       FROM fct_standard_charges c WHERE ${where.join(" AND ")}
      GROUP BY ALL ORDER BY ALL`,
    params,
  );
  if (input.payer) {
    where.push("contains(lower(c.payer_name), $payer)");
    params["payer"] = input.payer.toLowerCase();
  }

  const [count] = await db.query(
    ["fct_standard_charges", "dim_charge_codes"],
    `SELECT count(DISTINCT c.charge_id) AS n FROM fct_standard_charges c WHERE ${where.join(" AND ")}`,
    params,
  );
  const matched = int(count?.["n"]);
  if (matched === 0) {
    const payers = await db.query(
      ["fct_standard_charges", "dim_charge_codes"],
      `SELECT DISTINCT c.payer_name FROM fct_standard_charges c
        WHERE c.hospital_id = $hospital AND c.item_id IN (${ITEMS}) AND c.payer_name IS NOT NULL ORDER BY 1 LIMIT 40`,
      { hospital: input.hospital_id, code, family },
    );
    throw new NoMatchError(`No charge for code ${code} at ${input.hospital_id} matches every filter given.`, {
      found: [
        ...here.map((r) => `${str(r["setting"])} / ${str(r["rate_basis"])}: ${int(r["charge_rows"])} charge rows`),
        `payers: ${payers.map((p) => str(p["payer_name"])).join(", ") || "none named"}`,
      ],
      tryInstead: ["drop or change the rate_basis, setting or payer filter"],
    });
  }

  params["limit"] = input.limit;
  const rows = await db.query(
    ["fct_standard_charges", "dim_charge_codes"],
    `SELECT c.* FROM fct_standard_charges c WHERE ${where.join(" AND ")}
      ORDER BY c.payer_name NULLS LAST, c.plan_name NULLS LAST, c.setting, c.rate_basis, c.charge_id
      LIMIT $limit`,
    params,
  );
  const source = (await hospitalSources(db)).get(input.hospital_id);
  if (!source) throw new Error(`hospital ${input.hospital_id} is missing from the release's files table`);
  const prov = provenance(db, "fct_standard_charges", source);

  const rates = rows.map((r) => {
    const algorithm = strOrNull(r["negotiated_algorithm"]);
    return {
      payer_name: strOrNull(r["payer_name"]),
      plan_name: strOrNull(r["plan_name"]),
      setting: settingSchema.parse(str(r["setting"])),
      rate_basis: rateBasisSchema.parse(str(r["rate_basis"])),
      negotiated_rate: numOrNull(r["negotiated_rate"]),
      negotiated_dollar: numOrNull(r["negotiated_dollar"]),
      negotiated_percentage: numOrNull(r["negotiated_percentage"]),
      negotiated_algorithm: algorithm && algorithm.length > ALGORITHM_MAX ? `${algorithm.slice(0, ALGORITHM_MAX)}…` : algorithm,
      methodology: strOrNull(r["methodology"]),
      gross_charge: numOrNull(r["gross_charge"]),
      discounted_cash: numOrNull(r["discounted_cash"]),
      billing_class: strOrNull(r["billing_class"]),
      modifiers: strOrNull(r["modifiers"]),
      description: strOrNull(r["description"]),
      provenance: { ...prov, source_locator: str(r["source_locator"]) },
    };
  });

  const notes = [
    "Each row is one charge as the hospital published it (item × setting × payer/plan). A charge appears once even " +
      "when its item lists several codes.",
    "Published negotiated rates are contract terms, not what any given patient pays.",
  ];
  if (matched > rates.length) notes.push(`Showing ${rates.length} of ${matched} matching charges; raise limit (max 200) or filter by payer.`);
  const signature = (r: (typeof rates)[number]): string =>
    JSON.stringify([r.payer_name, r.plan_name, r.setting, r.rate_basis, r.negotiated_rate, r.negotiated_percentage,
      r.negotiated_algorithm, r.description, r.modifiers, r.billing_class]);
  const repeats = rates.length - new Set(rates.map(signature)).size;
  if (repeats > 0) {
    notes.push(
      `${repeats} returned row(s) repeat another row's published values at a different position in the hospital's ` +
        "file (see provenance.source_locator). They are separate entries in the source, kept as published.",
    );
  }
  if (rates.some((r) => r.negotiated_rate === null)) {
    notes.push("Rows with a null negotiated_rate publish a percentage or an algorithm instead of a dollar figure.");
  }

  return {
    release_tag: tag,
    hospital_id: input.hospital_id,
    code,
    code_family: family,
    matched_charges: matched,
    returned: rates.length,
    truncated: matched > rates.length,
    by_setting_and_basis: breakdown.map((b) => ({
      setting: settingSchema.parse(str(b["setting"])),
      rate_basis: rateBasisSchema.parse(str(b["rate_basis"])),
      charges: int(b["charges"]),
    })),
    rates,
    notes,
  };
}

const money = (n: number | null): string => (n === null ? "—" : `$${n.toFixed(2)}`);

export function registerGetPayerRates(server: McpServer, db: Db): void {
  server.registerTool(
    "get_payer_rates",
    {
      title: "Negotiated rates for one code at one hospital, by payer and plan",
      description:
        "Every published charge for one billing code at one hospital: payer, plan, setting, negotiated rate (or the " +
        "percentage/algorithm when no dollar figure is published), gross and cash price, with the charge's position " +
        "in the hospital's source file. The first call downloads the 117 MB charge table once.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const out = await getPayerRates(db, input);
      const lines = [`${out.code} at ${out.hospital_id}: ${out.matched_charges} matching charges, showing ${out.returned}.`];
      for (const r of out.rates.slice(0, 25)) {
        const rate = r.negotiated_rate !== null ? money(r.negotiated_rate) : r.negotiated_percentage !== null ? `${r.negotiated_percentage}% of charge` : "algorithm";
        lines.push(
          `- ${r.payer_name ?? "(no payer)"} / ${r.plan_name ?? "-"}, ${r.setting}: ${rate} [${r.rate_basis}] ` +
            `(file position ${r.provenance.source_locator})`,
        );
      }
      if (out.rates.length > 25) lines.push(`… ${out.rates.length - 25} more in structured output`);
      for (const n of out.notes) lines.push(`Note: ${n}`);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: out };
    },
  );
}
