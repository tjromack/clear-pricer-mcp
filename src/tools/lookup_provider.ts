import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { int, str, strOrNull, type Db, type Row } from "../db.js";
import { NoMatchError } from "../errors.js";

export const inputSchema = {
  npi: z.string().regex(/^\d{10}$/, "an NPI is exactly 10 digits").describe("National Provider Identifier, 10 digits"),
  as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
    .optional()
    .describe("Date to look the provider up as of (YYYY-MM-DD). Omit for the current registration."),
};

const versionSchema = z.object({
  version: z.number().int(),
  valid_from: z.string(),
  valid_to: z.string().nullable().describe("Exclusive; null = current"),
  status: z.string(),
  change_type: z.string(),
  valid_on_no_day: z.boolean().describe("valid_from = valid_to: superseded the same day, never the answer to an as-of query"),
  source_file: z.string().describe("NPPES file that introduced this version"),
});

export const outputSchema = {
  release_tag: z.string(),
  npi: z.string(),
  as_of: z.string().nullable().describe("The date asked about, or null for the current registration"),
  version: z.number().int(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  entity: z.enum(["individual", "organization", "unknown"]).describe("unknown = NPPES published only a deactivation notice"),
  name: z.string().nullable(),
  credential: z.string().nullable(),
  status: z.string(),
  practice_address: z.object({
    line_1: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postal_code: z.string().nullable(),
    country: z.string().nullable(),
  }),
  primary_taxonomy: z.string().nullable(),
  taxonomy_codes: z.array(z.string()),
  enumeration_date: z.string().nullable(),
  deactivation_date: z.string().nullable(),
  deactivation_reason: z.string().nullable(),
  replacement_npi: z.string().nullable(),
  versions: z.array(versionSchema).describe("Every version of this NPI in the release's history"),
  disclosed_by: z
    .array(z.object({ hospital_id: z.string(), hospital_name: z.string(), outcome: z.string() }))
    .describe("Hospitals in the release whose price file discloses this NPI, with clear-pricer's reconciliation outcome"),
  provenance: z.object({
    release_tag: z.string(),
    table: z.literal("dim_provider_history"),
    nppes_file: z.string().describe("NPPES file that introduced the version returned"),
    read: z.literal("remote_range_read").describe("Read by HTTP range from the pinned release, size-checked, not hashed"),
  }),
  notes: z.array(z.string()),
};

type Input = { npi: string; as_of?: string | undefined };
type Output = z.infer<z.ZodObject<typeof outputSchema>>;

/** NPI check digit: Luhn over the 9 base digits prefixed with 80840 (the US health-industry issuer prefix). */
export function npiCheckDigit(first9: string): number {
  const digits = `80840${first9}`.split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = digits[i] ?? 0;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const fullName = (r: Row): string | null => {
  const org = strOrNull(r["org_name"]);
  if (org) return org;
  const parts = [r["first_name"], r["middle_name"], r["last_name"]].map(strOrNull).filter((p): p is string => !!p);
  return parts.length ? parts.join(" ") : null;
};

export async function lookupProvider(db: Db, input: Input): Promise<Output> {
  const { npi } = input;
  const tag = db.release.pin.tag;
  const expected = npiCheckDigit(npi.slice(0, 9));
  if (Number(npi[9]) !== expected) {
    throw new NoMatchError(
      `${npi} is not a valid NPI: its check digit is ${npi[9]}, but the first nine digits require ${expected}. ` +
        `It is most likely mistyped.`,
    );
  }
  if (input.as_of !== undefined && !isRealDate(input.as_of)) {
    throw new NoMatchError(`as_of ${input.as_of} is not a real calendar date.`);
  }

  // Half-open intervals: a version is valid on day d when valid_from <= d < valid_to (NULL = current).
  const versions = await db.query(
    ["dim_provider_history"],
    `SELECT *, CAST(valid_from AS VARCHAR) AS vf, CAST(valid_to AS VARCHAR) AS vt,
            CAST(enumeration_date AS VARCHAR) AS enumerated, CAST(deactivation_date AS VARCHAR) AS deactivated,
            to_json(coalesce(taxonomy_codes, [])) AS taxonomies
       FROM dim_provider_history WHERE npi = $npi ORDER BY version`,
    { npi },
  );
  if (versions.length === 0) {
    throw new NoMatchError(`NPI ${npi} is not in the NPPES history of release ${tag}.`, {
      tryInstead: [
        "check the number: it passes the check digit, so it may be valid but not yet (or no longer) in the NPPES files this release applied",
        "release_info lists the NPPES files the history was built from",
      ],
    });
  }

  const summary = versions.map((v) => ({
    version: int(v["version"]),
    valid_from: str(v["vf"]),
    valid_to: strOrNull(v["vt"]),
    status: str(v["status"]),
    change_type: str(v["change_type"]),
    valid_on_no_day: strOrNull(v["vt"]) === str(v["vf"]),
    source_file: str(v["source_file"]),
  }));
  const pick = input.as_of
    ? versions.find((v) => str(v["vf"]) <= (input.as_of ?? "") && (strOrNull(v["vt"]) === null || (input.as_of ?? "") < str(v["vt"])))
    : versions.find((v) => strOrNull(v["vt"]) === null);
  if (!pick) {
    throw new NoMatchError(`NPI ${npi} has no registration valid on ${input.as_of ?? "the current date"} in release ${tag}.`, {
      found: summary.map((s) => `version ${s.version}: ${s.status}, valid ${s.valid_from} to ${s.valid_to ?? "now"}`),
      tryInstead: ["an as_of date inside one of the ranges above (valid_to is exclusive)"],
    });
  }

  const disclosed = await db.query(
    ["rpt_npi_resolution"],
    `SELECT hospital_id, hospital_name, outcome FROM rpt_npi_resolution WHERE npi = $npi ORDER BY hospital_id`,
    { npi },
  );
  const entityType = strOrNull(pick["entity_type"]);
  const notes: string[] = [];
  if (entityType === null) {
    notes.push("NPPES published only a deactivation notice for this version: every field but the NPI and dates is blank.");
  }
  if (summary.some((s) => s.valid_on_no_day)) {
    notes.push("One version was superseded the same day it took effect, so it is valid on no day and is never returned.");
  }
  notes.push("valid_from is the record's own effective date in NPPES, not the day the pipeline saw it.");

  return {
    release_tag: tag,
    npi,
    as_of: input.as_of ?? null,
    version: int(pick["version"]),
    valid_from: str(pick["vf"]),
    valid_to: strOrNull(pick["vt"]),
    entity: entityType === "1" ? "individual" : entityType === "2" ? "organization" : "unknown",
    name: fullName(pick),
    credential: strOrNull(pick["credential"]),
    status: str(pick["status"]),
    practice_address: {
      line_1: strOrNull(pick["practice_address_1"]),
      city: strOrNull(pick["practice_city"]),
      state: strOrNull(pick["practice_state"]),
      postal_code: strOrNull(pick["practice_postal"]),
      country: strOrNull(pick["practice_country"]),
    },
    primary_taxonomy: strOrNull(pick["primary_taxonomy"]),
    taxonomy_codes: z.array(z.string()).parse(JSON.parse(str(pick["taxonomies"]))),
    enumeration_date: strOrNull(pick["enumerated"]),
    deactivation_date: strOrNull(pick["deactivated"]),
    deactivation_reason: strOrNull(pick["deactivation_reason"]),
    replacement_npi: strOrNull(pick["replacement_npi"]),
    versions: summary,
    disclosed_by: disclosed.map((d) => ({
      hospital_id: str(d["hospital_id"]),
      hospital_name: str(d["hospital_name"]),
      outcome: str(d["outcome"]),
    })),
    provenance: { release_tag: tag, table: "dim_provider_history", nppes_file: str(pick["source_file"]), read: "remote_range_read" },
    notes,
  };
}

export function registerLookupProvider(server: McpServer, db: Db): void {
  server.registerTool(
    "lookup_provider",
    {
      title: "Who an NPI belonged to, as of a date",
      description:
        "Look up a National Provider Identifier in the NPPES registry history: name, entity type, status, practice " +
        "address and taxonomy as of a date (or now), every version on record, and whether a hospital in the release " +
        "discloses it. Validates the NPI check digit first.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const out = await lookupProvider(db, input);
      const where = [out.practice_address.city, out.practice_address.state].filter(Boolean).join(", ");
      const text =
        `NPI ${out.npi}${out.as_of ? ` as of ${out.as_of}` : ""}: ${out.name ?? "(no name published)"} ` +
        `(${out.entity}, ${out.status}${where ? `, ${where}` : ""}), version ${out.version} valid ` +
        `${out.valid_from} to ${out.valid_to ?? "now"}, from ${out.provenance.nppes_file}.` +
        (out.disclosed_by.length ? ` Disclosed by: ${out.disclosed_by.map((d) => d.hospital_name).join(", ")}.` : "");
      return { content: [{ type: "text", text }], structuredContent: out };
    },
  );
}
