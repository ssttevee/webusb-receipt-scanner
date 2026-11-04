# Evidence-backed timestamp extraction baseline

Date: 2026-11-03

Related: [Expanded corpus review](receipt-sample-review-2026-10-25.md), [runtime contract](../application-runtime.md), RA-05 / RA-12 / RA-13.

## Result

The first automatic proposal path is implemented and integrated with staging. It proposes timestamps for **22 of 53** corrected development samples. All 22 match the saved date and naming minute; the 13 proposals with seconds-bearing ground truth also match the labelled seconds. **31 samples remain in review**, including the deliberately missing-time and invalid-printed-seconds cases.

These are results on an inspected development corpus used to refine the rules. Zero observed errors among 22 proposals is not a held-out accuracy estimate or a release guarantee. Every proposal still needs explicit user confirmation before approval. The next accuracy gain must improve difficult OCR and date association, not guess among unresolved values.

| Measurement | Result |
| --- | --- |
| Corrected, confirmed raw samples | 53 |
| Proposed timestamp / review | 22 / 31 |
| Proposal coverage | 41.5% |
| Proposed date and naming minute match | 22/22 proposals; 22/53 corpus-wide |
| Proposed seconds match, when ground truth includes seconds | 13/13 such proposals |
| Observed incorrect proposals at declared label precision | 0 |
| Expected missing-time / malformed-seconds review cases | 2/2 retained in review |
| Reserved unseen evaluation samples | 0 |

## Method

- Used the current corrected ZIP labels for scoring. Supplied labels are confirmed; the severely faded date remains user-attested ground truth. The benchmark refuses unconfirmed labels.
- Fed only original pixels, DPI and language profile into recognition. Expected dates/times and special review annotations reach only the scorer. The production worker has no sample-label input.
- Used `reference-tiles-v2`: estimated paper-region OCR geometry, unchanged grayscale PSM 11 discovery, and overlapping 1,600-row PSM 6 copies with a bounded black-point contrast adjustment. The selected color/grayscale reference master retains all original pixels.
- Used Tesseract **5.3.0**, the bundled five language packs, and at most two OpenMP threads. Each receipt uses its selected supported language profile; Korean-labelled body text is outside the required OCR scope.
- Used `timestamp-evidence-v2` with no assumed numeric order or two-digit-year century. The parser validates calendars/clocks, retains alternatives and source boxes, and selects the earliest supported complete transaction timestamp.
- Required direct support from two OCR passes or repeated printed regions. Two passes share the original pixels and can share errors; their agreement is not independent statistical proof.
- Kept all per-receipt OCR, TSVs, candidate text/boxes, labels and results private under `.receipt-samples/benchmark-v1/` and `benchmark-v2/`. The benchmark reads source ZIPs without modifying them.

An exploratory configuration produced 26 proposals, including two wrong OCR dates. The final evidence gate removed those two and two correct single-source proposals. This is a measured coverage/precision tradeoff on this development set, not proof that the remaining gate generalizes.

### Language-labelled coverage

Counts overlap for mixed-language receipts. The date/time fields in Chinese/French-labelled examples often use ASCII notation; these counts do not establish broad language-specific extraction accuracy.

| Language label | Samples | Final proposals |
| --- | --- | --- |
| English | 48 | 20 |
| French | 3 | 1 |
| Japanese | 7 | 4 |
| Traditional Chinese | 3 | 1 |
| Simplified Chinese | 1 | 0 |
| Korean (additional corpus label) | 1 | 0 |

The simplified-Chinese example has deliberately malformed printed seconds and correctly remains in review. Synthetic parser tests cover French month names, Japanese/Chinese markers and Japanese era boundaries; those tests do not substitute for real OCR coverage.

## Review causes and limits

- Faded/marked-up regions still produce no complete date/time or only one directly parsed source. Contrast copies improve some digits and damage others; the unchanged discovery pass remains available.
- Two-digit years and ambiguous month/day order remain unresolved without explicit policy or reliable independent printed evidence. A broad archive does not justify assuming a century.
- Some terminal/register dates disagree despite equal clock minutes. Some OCR passes disagree in the same printed region. Both cases retain their evidence for manual review.
- Unpaired transaction-like clocks, reference-embedded timestamps, closing-only evidence, and invalid printed times require source checks. The parser does not independently minimize a date and a clock from different records.
- Empty/missing seconds are not observed `00`. The selected source retains minute/second precision. Filename comparison and seconds comparison are separate scoring fields.

The fresh OCR run took approximately **143.1 seconds total** for the 53 receipts, with approximately **147.5 seconds** for decode/OCR/artifact work. The final parser/evidence-gate evaluation reused checksum/version/profile-matched OCR. These measurements came from an **amd64 container on an arm64 workstation under emulation**, not the NAS. The recognizer uses per-pass CLI processes; warm-engine and challenger comparisons remain open.

## Repeatable benchmark

Build the image with the current source. Choose a private output directory before the first run.

```sh
docker build --platform linux/amd64 -t receipt-scanner:extraction .
mkdir -p .receipt-samples/benchmark-local
docker run --rm --no-healthcheck --platform linux/amd64 --memory 8g \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/.receipt-samples:/corpus:ro" \
  -v "$PWD/.receipt-samples/benchmark-local:/result" \
  --entrypoint python receipt-scanner:extraction \
  -m server.benchmark --samples /corpus --output /result \
  --review-cases /corpus/review/extraction-review-cases.json \
  --hardware "describe the actual benchmark hardware"
```

The optional private review-cases file maps sample prefixes to source defects for scoring only; omit that argument if it is unavailable. Missing labelled time already counts as an expected review case. Add `--reuse-ocr` for parser-only comparisons after a full run. Reuse checks the original checksum, recognizer version and selected language profile; it does not claim a fresh OCR timing. `--date-order` and `--century` are explicit policy experiments, not automatically selected from expected labels.

## Next measured work

Verification for this increment: **51 Python backend/parser/provider tests**, **3 application browser tests**, TypeScript/Vite build, Ruff checks and both synthetic/real-long-receipt amd64 container checks passed. The real receipt's PDF pixels still match the original raw checksum after the OCR changes. Schema migration and the explicit proposal-confirmation gate are included in the tests.

1. Freeze a layout/group regression split and obtain a genuinely unseen set before release evaluation.
2. Compare a warm Tesseract API and the RapidOCR/ONNX challenger on the same originals, especially faded regions and Japanese small text.
3. Improve source-region OCR and timestamp association with measured false-proposal/review counts. Preserve partial and rejected evidence.
4. Add explicit per-intake or confirmed-layout date conventions, rather than global guesses for the mixed archive.
5. Keep image-master enhancement/ranking separate from OCR-only copies until text-preservation checks justify promotion.
