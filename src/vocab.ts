import { z } from "zod";

// The closed vocabularies of the pinned release. Input schemas use them as enums so an assistant sees the valid
// choices up front; tests/release/vocab.release.test.ts proves each list equals the distinct values in the release.

export const HOSPITAL_IDS = ["nm", "rush", "uchicago"] as const;
export const SETTINGS = ["inpatient", "outpatient", "both"] as const;
export const RATE_BASES = [
  "dollar",
  "dollar_from_percent",
  "dollar_percent_unreconciled",
  "algorithm_only",
  "percent_only",
  "no_payer",
] as const;
export const CODE_FAMILIES = [
  "CDT",
  "CPT_CAT_I",
  "CPT_CAT_II",
  "CPT_CAT_III",
  "CPT_MAAA",
  "CPT_PLA",
  "HCPCS_II",
  "MS-DRG",
] as const;

export type HospitalId = (typeof HOSPITAL_IDS)[number];
export type Setting = (typeof SETTINGS)[number];
export type RateBasis = (typeof RATE_BASES)[number];

export const hospitalIdSchema = z
  .enum(HOSPITAL_IDS)
  .describe("nm = Northwestern Memorial Hospital, rush = RUSH University Medical Center, uchicago = The University of Chicago Medical Center");
export const settingSchema = z.enum(SETTINGS);
export const rateBasisSchema = z.enum(RATE_BASES);
export const codeFamilySchema = z.enum(CODE_FAMILIES);

/** Rate bases whose rows carry a dollar figure; the others have NULL rate columns by construction. */
export const HAS_DOLLARS: ReadonlySet<string> = new Set(["dollar", "dollar_from_percent", "dollar_percent_unreconciled"]);

export const RATE_BASIS_HELP =
  "How the negotiated rate was published. 'dollar' = contracted dollar amount; 'dollar_from_percent' = a percentage " +
  "of the hospital's own charge, converted to dollars; 'dollar_percent_unreconciled' = a dollar and a percentage that " +
  "disagree (the dollar is used); 'algorithm_only', 'percent_only' and 'no_payer' carry no dollar rate.";

/** Normalise a billing code as hospitals publish it: trimmed, upper-case. */
export const normaliseCode = (code: string): string => code.trim().toUpperCase();
