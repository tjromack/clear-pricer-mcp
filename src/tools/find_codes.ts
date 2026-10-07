import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBValue } from "@duckdb/node-api";
import { z } from "zod";
import { int, str, type Db } from "../db.js";
import { NoMatchError } from "../errors.js";
import { hospitalSources } from "../provenance.js";
import { CODE_FAMILIES, codeFamilySchema, hospitalIdSchema, normaliseCode, type HospitalId } from "../vocab.js";

const stringList = z.array(z.string());
const describedList = z.array(z.object({ hospital_id: z.string(), description: z.string() }));
const matchesAll = (description: string, words: string[]): boolean =>
  words.length > 0 && words.every((w) => description.toLowerCase().includes(w));

const STOPWORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with", "w", "cost", "price"]);

export const inputSchema = {
  query: z
    .string()
    .min(2)
    .max(120)
    .describe(
      "Words to find in the hospitals' own item descriptions (e.g. 'mri brain', 'office visit established'), or a " +
        "billing code. Every word must appear. Hospitals abbreviate: try 'MRI', 'CT', 'XR', 'W/O', 'Lwr Extre'.",
    ),
  code_family: codeFamilySchema.optional().describe("Restrict to one code family, e.g. CPT_CAT_I or MS-DRG"),
  hospital_id: hospitalIdSchema.optional().describe("Only codes this hospital publishes"),
  limit: z.number().int().min(1).max(50).default(20),
};

const resultSchema = z.object({
  code: z.string(),
  code_family: z.enum(CODE_FAMILIES),
  hospital_ids: z.array(z.string()).describe("Hospitals that publish a price for this code"),
  descriptions: z
    .array(
      z.object({
        hospital_id: z.string(),
        description: z.string(),
        matched: z.boolean().describe("This description contains every search word"),
        source_filename: z.string(),
      }),
    )
    .describe("Each hospital's own description of the item, as published in its file; matching ones first"),
  settings: z.array(z.string()),
  charges: z.number().int().describe("Distinct charge rows carrying this code, across the hospitals"),
});

export const outputSchema = {
  release_tag: z.string(),
  query: z.string(),
  matched_words: z.array(z.string()).describe("The words every description had to contain"),
  results: z.array(resultSchema).describe("Most widely published first, then most charge rows"),
  truncated: z.boolean().describe("More codes matched than `limit`; narrow the query"),
  notes: z.array(z.string()),
};

type Input = { query: string; code_family?: string | undefined; hospital_id?: HospitalId | undefined; limit: number };
type Output = z.infer<z.ZodObject<typeof outputSchema>>;

export function searchWords(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9/]+/)
        .filter((w) => w.length >= 2 && !STOPWORDS.has(w)),
    ),
  ];
}

export async function findCodes(db: Db, input: Input): Promise<Output> {
  const words = searchWords(input.query);
  const asCode = normaliseCode(input.query);
  const params: Record<string, DuckDBValue> = { code: asCode, limit: input.limit + 1 };
  words.forEach((w, i) => (params[`w${i}`] = w));
  const wordMatch = words.length ? words.map((_, i) => `contains(lower(example_description), $w${i})`).join(" AND ") : "false";
  const filters: string[] = [];
  if (input.code_family) {
    filters.push("code_family = $family");
    params["family"] = input.code_family;
  }
  if (input.hospital_id) {
    filters.push("code IN (SELECT code FROM agg_code_prices WHERE hospital_id = $hospital)");
    params["hospital"] = input.hospital_id;
  }

  // agg_code_prices: one row per hospital × family × code × setting × rate basis. sum(charge_rows) over a code is
  // the number of distinct charges carrying it (check_values derived.agg_code_prices_fanout = 1.0).
  const rows = await db.query(
    ["agg_code_prices"],
    `WITH hits AS (
       SELECT DISTINCT code_family, code FROM agg_code_prices
        WHERE (code = $code OR (${wordMatch})) ${filters.map((f) => `AND ${f}`).join(" ")}
     )
     SELECT a.code_family, a.code,
            to_json(list(DISTINCT a.hospital_id ORDER BY a.hospital_id)) AS hospital_ids,
            to_json(list(DISTINCT a.setting ORDER BY a.setting)) AS settings,
            to_json(list(DISTINCT {'hospital_id': a.hospital_id, 'description': a.example_description}
                         ORDER BY {'hospital_id': a.hospital_id, 'description': a.example_description})) AS descriptions,
            sum(a.charge_rows) AS charges,
            (a.code = $code) AS exact
       FROM agg_code_prices a JOIN hits USING (code_family, code)
      GROUP BY a.code_family, a.code
      ORDER BY exact DESC, count(DISTINCT a.hospital_id) DESC, charges DESC, a.code
      LIMIT $limit`,
    params,
  );

  if (rows.length === 0) {
    throw new NoMatchError(
      `No billing code in release ${db.release.pin.tag} has a hospital description containing ` +
        `${words.length ? words.map((w) => `'${w}'`).join(" and ") : `the code '${asCode}'`}` +
        `${input.code_family ? ` in family ${input.code_family}` : ""}${input.hospital_id ? ` at ${input.hospital_id}` : ""}.`,
      {
        tryInstead: [
          "fewer words: every word must appear in the same description",
          "the abbreviations hospitals use: 'MRI', 'CT', 'XR', 'US' (ultrasound), 'W/O' (without), 'Lwr Extre' (lower extremity), 'Est' (established)",
          "a body part or procedure name rather than a symptom or condition",
        ],
      },
    );
  }

  const truncated = rows.length > input.limit;
  const kept = rows.slice(0, input.limit);
  const sources = await hospitalSources(db);
  const results = kept.map((r) => ({
    code: str(r["code"]),
    code_family: codeFamilySchema.parse(str(r["code_family"])),
    hospital_ids: stringList.parse(JSON.parse(str(r["hospital_ids"]))),
    settings: stringList.parse(JSON.parse(str(r["settings"]))),
    charges: int(r["charges"]),
    descriptions: describedList
      .parse(JSON.parse(str(r["descriptions"])))
      .map((d) => ({ ...d, matched: matchesAll(d.description, words), source_filename: sources.get(d.hospital_id)?.source_filename ?? "" }))
      .sort((a, b) => Number(b.matched) - Number(a.matched)),
  }));

  const notes = ["Descriptions are the hospitals' own wording from their price files, not AMA CPT descriptors."];
  if (results.some((r) => r.code === asCode)) notes.push(`'${asCode}' matched a code exactly; it is listed first.`);
  for (const r of results.filter((x) => x.code !== asCode)) {
    const matchedBy = [...new Set(r.descriptions.filter((d) => d.matched).map((d) => d.hospital_id))];
    const others = r.hospital_ids.filter((h) => !matchedBy.includes(h));
    if (matchedBy.length > 0 && others.length > 0) {
      notes.push(
        `${r.code} matched only in the description from ${matchedBy.join(", ")}; ${others.join(", ")} ` +
          `${others.length === 1 ? "describes" : "describe"} it differently. ` +
          `Check the descriptions agree before treating it as the same service.`,
      );
    }
  }
  return { release_tag: db.release.pin.tag, query: input.query, matched_words: words, results, truncated, notes };
}

export function registerFindCodes(server: McpServer, db: Db): void {
  server.registerTool(
    "find_codes",
    {
      title: "Find billing codes from a plain-language description",
      description:
        "Search the hospitals' own item descriptions (as published in their price files) for billing codes, e.g. " +
        "'mri brain' or 'office visit established'. Returns each code with the hospitals that publish it and their " +
        "descriptions. Use the code with compare_code_prices or get_payer_rates.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const out = await findCodes(db, input);
      const lines = out.results.map(
        (r) =>
          `- ${r.code} (${r.code_family}) at ${r.hospital_ids.join(", ")}: ` +
          [...new Set(r.descriptions.map((d) => `${d.description}${d.matched ? "" : " (no match)"}`))].slice(0, 2).join(" / "),
      );
      if (out.truncated) lines.push(`(more than ${out.results.length} matched; narrow the query)`);
      for (const n of out.notes) lines.push(`Note: ${n}`);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: out };
    },
  );
}
