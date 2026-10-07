import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { int, numOrNull, str, type Db, type Row } from "../db.js";
import { NoMatchError } from "../errors.js";
import { hospitalSources, provenance, provenanceSchema, type HospitalSource } from "../provenance.js";
import { HAS_DOLLARS, RATE_BASES, RATE_BASIS_HELP, SETTINGS, normaliseCode } from "../vocab.js";

export const inputSchema = {
  code: z
    .string()
    .min(1)
    .max(16)
    .describe("Billing code as published, e.g. CPT 99213, HCPCS J1885, MS-DRG 470. Use find_codes to get one."),
  rate_basis: z
    .enum(RATE_BASES)
    .default("dollar")
    .describe(`${RATE_BASIS_HELP} Compare hospitals on 'dollar' unless asked otherwise.`),
  setting: z
    .enum(SETTINGS)
    .optional()
    .describe("Restrict to one care setting. Omit to get every setting, one row per hospital and setting."),
  code_family: z
    .string()
    .optional()
    .describe("Only needed if the code string exists in more than one code family (the tool says so)."),
};

const priceRowSchema = z.object({
  hospital_id: z.string(),
  hospital_name: z.string(),
  setting: z.enum(SETTINGS),
  rate_basis: z.enum(RATE_BASES),
  charge_rows: z.number().int().describe("Charge rows behind this summary"),
  payer_plans: z.number().int().describe("Distinct payer × plan combinations"),
  rate_min: z.number().nullable(),
  rate_p25: z.number().nullable(),
  rate_median: z.number().nullable(),
  rate_p75: z.number().nullable(),
  rate_max: z.number().nullable(),
  gross_charge_median: z.number().nullable().describe("Median chargemaster (list) price"),
  cash_price_median: z.number().nullable().describe("Median discounted cash price"),
  example_description: z.string().describe("The hospital's own description of the item"),
  provenance: provenanceSchema,
});

const publishedSchema = z.object({
  setting: z.enum(SETTINGS),
  rate_basis: z.enum(RATE_BASES),
  charge_rows: z.number().int(),
  has_dollar_rates: z.boolean(),
});

export const outputSchema = {
  release_tag: z.string(),
  code: z.string(),
  code_family: z.string(),
  rate_basis: z.enum(RATE_BASES),
  setting: z.enum(SETTINGS).nullable().describe("The setting filter applied, or null for all settings"),
  prices: z.array(priceRowSchema).describe("One row per hospital × setting. Never averaged or summed across rows."),
  not_included: z
    .array(
      z.object({
        hospital_id: z.string(),
        hospital_name: z.string(),
        published: z.array(publishedSchema).describe("What this hospital does publish for the code; empty = nothing"),
      }),
    )
    .describe("Hospitals with no row under this rate basis and setting, and what they publish instead"),
  notes: z.array(z.string()),
};

type Input = { code: string; rate_basis: (typeof RATE_BASES)[number]; setting?: (typeof SETTINGS)[number] | undefined; code_family?: string | undefined };
type Output = z.infer<z.ZodObject<typeof outputSchema>>;

const asSetting = (v: string): (typeof SETTINGS)[number] => z.enum(SETTINGS).parse(v);
const asBasis = (v: string): (typeof RATE_BASES)[number] => z.enum(RATE_BASES).parse(v);

function describePublished(rows: Row[]): z.infer<typeof publishedSchema>[] {
  return rows.map((r) => ({
    setting: asSetting(str(r["setting"])),
    rate_basis: asBasis(str(r["rate_basis"])),
    charge_rows: int(r["charge_rows"]),
    has_dollar_rates: HAS_DOLLARS.has(str(r["rate_basis"])),
  }));
}

const fmt = (p: z.infer<typeof publishedSchema>): string =>
  `${p.setting} / ${p.rate_basis}: ${p.charge_rows} charge rows${p.has_dollar_rates ? "" : " (no dollar rate)"}`;

export async function compareCodePrices(db: Db, input: Input): Promise<Output> {
  const code = normaliseCode(input.code);
  const tag = db.release.pin.tag;
  const hospitals = await hospitalSources(db);

  // Grain: hospital × code_family × code × setting × rate_basis. Everything for one code is a few rows.
  const all = await db.query(
    ["agg_code_prices"],
    `SELECT * FROM agg_code_prices WHERE code = $code ORDER BY hospital_id, setting, rate_basis`,
    { code },
  );
  if (all.length === 0) {
    throw new NoMatchError(`Code ${code} is not priced in any hospital's file in release ${tag}.`, {
      tryInstead: [
        "find_codes with a plain-language description (e.g. 'knee MRI') to get the codes hospitals actually use",
        "check the code's format: CPT is 5 digits (99213), HCPCS is a letter and 4 digits (J1885), MS-DRG is 3 digits (470)",
      ],
    });
  }

  const families = [...new Set(all.map((r) => str(r["code_family"])))];
  const family = input.code_family ?? (families.length === 1 ? families[0] : undefined);
  if (family === undefined) {
    throw new NoMatchError(`Code ${code} exists in more than one code family; prices are not comparable across them.`, {
      found: families.map((f) => `code_family '${f}'`),
      tryInstead: ["call again with code_family set to one of the families above"],
    });
  }
  const inFamily = all.filter((r) => str(r["code_family"]) === family);
  if (inFamily.length === 0) {
    throw new NoMatchError(`Code ${code} has no rows in code family '${family}'.`, {
      found: families.map((f) => `code_family '${f}'`),
    });
  }

  const matches = (r: Row): boolean =>
    str(r["rate_basis"]) === input.rate_basis && (input.setting === undefined || str(r["setting"]) === input.setting);
  const byHospital = (id: string): Row[] => inFamily.filter((r) => str(r["hospital_id"]) === id);
  const label = `rate_basis '${input.rate_basis}'${input.setting ? ` and setting '${input.setting}'` : ""}`;

  const prices = inFamily.filter(matches).map((r) => {
    const source = hospitals.get(str(r["hospital_id"]));
    if (!source) throw new Error(`hospital ${str(r["hospital_id"])} is missing from the release's files table`);
    return {
      hospital_id: source.hospital_id,
      hospital_name: source.hospital_name,
      setting: asSetting(str(r["setting"])),
      rate_basis: asBasis(str(r["rate_basis"])),
      charge_rows: int(r["charge_rows"]),
      payer_plans: int(r["payer_plans"]),
      rate_min: numOrNull(r["rate_min"]),
      rate_p25: numOrNull(r["rate_p25"]),
      rate_median: numOrNull(r["rate_median"]),
      rate_p75: numOrNull(r["rate_p75"]),
      rate_max: numOrNull(r["rate_max"]),
      gross_charge_median: numOrNull(r["gross_median"]),
      cash_price_median: numOrNull(r["cash_median"]),
      example_description: str(r["example_description"]),
      provenance: provenance(db, "agg_code_prices", source),
    };
  });

  const notIncluded = [...hospitals.values()]
    .filter((h: HospitalSource) => !prices.some((p) => p.hospital_id === h.hospital_id))
    .map((h) => ({
      hospital_id: h.hospital_id,
      hospital_name: h.hospital_name,
      published: describePublished(byHospital(h.hospital_id)),
    }));

  if (prices.length === 0) {
    throw new NoMatchError(`No hospital publishes code ${code} under ${label} in release ${tag}.`, {
      found: notIncluded.map(
        (h) =>
          `${h.hospital_name} (${h.hospital_id}): ` +
          (h.published.length ? h.published.map(fmt).join("; ") : "does not list this code"),
      ),
      tryInstead: ["call again with one of the rate_basis / setting combinations listed above"],
    });
  }

  const notes = [
    "Each price row is one hospital × setting × rate basis, summarised over that hospital's payer plans. Compare " +
      "rows within one setting; do not average or add medians across rows.",
  ];
  if (new Set(prices.map((p) => p.setting)).size > 1) {
    notes.push("These rows span more than one setting; rows from different settings are not like-for-like.");
  }
  if (!HAS_DOLLARS.has(input.rate_basis)) {
    notes.push(`rate_basis '${input.rate_basis}' carries no dollar rate, so the rate columns are null by construction.`);
  }
  for (const h of notIncluded.filter((n) => n.published.length > 0)) {
    notes.push(`${h.hospital_name} publishes this code, but not under ${label}: ${h.published.map(fmt).join("; ")}.`);
  }

  return {
    release_tag: tag,
    code,
    code_family: family,
    rate_basis: input.rate_basis,
    setting: input.setting ?? null,
    prices,
    not_included: notIncluded,
    notes,
  };
}

const money = (n: number | null): string => (n === null ? "—" : `$${n.toFixed(2)}`);

function summary(o: Output): string {
  const lines = [`${o.code} (${o.code_family}), rate basis ${o.rate_basis}, release ${o.release_tag}:`];
  for (const p of o.prices) {
    lines.push(
      `- ${p.hospital_name}, ${p.setting}: median ${money(p.rate_median)} (range ${money(p.rate_min)}–${money(p.rate_max)}, ` +
        `${p.payer_plans} payer plan${p.payer_plans === 1 ? "" : "s"}) — source ${p.provenance.source_filename}, updated ${p.provenance.source_last_updated_on}`,
    );
  }
  for (const n of o.notes) lines.push(`Note: ${n}`);
  return lines.join("\n");
}

export function registerCompareCodePrices(server: McpServer, db: Db): void {
  server.registerTool(
    "compare_code_prices",
    {
      title: "Compare one billing code's prices across hospitals",
      description:
        "Negotiated-rate summary (min, quartiles, max over payer plans) for one billing code at each hospital in " +
        "the release, for one rate basis, with the hospital's source file cited on every row. Hospitals that publish " +
        "the code differently are listed in not_included with what they do publish.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const out = await compareCodePrices(db, input);
      return { content: [{ type: "text", text: summary(out) }], structuredContent: out };
    },
  );
}
