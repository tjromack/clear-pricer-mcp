# Recording the demo session

For the README GIF and the case study. About two minutes. Record the terminal (e.g. ScreenToGif or asciinema).

## Setup (before recording)

```bash
claude mcp add clear-pricer -- npx -y clear-pricer-mcp
# behind the TLS-inspecting proxy on this machine, pass the CA explicitly:
claude mcp add clear-pricer -e NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" -- npx -y clear-pricer-mcp
```

Ask one throwaway question first so the 117 MB charge table is already cached and the recording has no wait.

## The questions, in order

Each one shows a different property; keep them in this order.

1. **"What does an established-patient office visit cost at the three Chicago hospitals?"**
   Shows: `find_codes` → 99213, then `compare_code_prices` with cited source files. Rush and UChicago come back with
   contracted dollars; Northwestern is named as publishing the code only as percent-derived rates (276 charges).
2. **"Then show me Northwestern's rates for it by payer."**
   Shows: `get_payer_rates` with `rate_basis` other than dollar; each row cited by its position in the file.
3. **"Search for a brain MRI code. Do the hospitals agree on what 44373 is?"**
   Shows: the matched-description flags and the note that 44373 matched only on UChicago's wording.
4. **"Who was NPI 1497859649 on October 1, 2026, and does a hospital in this data disclose it?"**
   Shows: `lookup_provider` as-of, with the disclosing hospital. (Not June 30: this release's history for that NPI
   starts 2026-07-16, so the tool would say so and list the valid range, which is correct but a detour.)
5. **"How much should I trust Northwestern's file?"**
   Shows: `data_quality`: 2 of 2 NPIs verified, 10.5% disclosure coverage, its template deviations.

## Keep in the cut

The moment the assistant explains why a hospital is missing from a comparison. That is the point of the build.
