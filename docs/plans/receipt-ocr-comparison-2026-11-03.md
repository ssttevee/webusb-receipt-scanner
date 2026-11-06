# CPU OCR comparison and review-case analysis

Date: 2026-11-03

Related: [Extraction baseline](receipt-extraction-baseline-2026-11-03.md), [runtime contract](../application-runtime.md), RA-05 / RA-10 / RA-12.

## Decision

The Docker worker now uses **persistent Tesseract APIs** by default. The API path produced identical OCR lines and identical timestamp selections on all 53 samples. It reduced total decode/OCR time by about **35%** in this controlled test. It retains at most three language profiles and resets adaptive state between passes, so it does not silently learn from prior receipts.

**RapidOCR remains a benchmark challenger.** It produced 29 correct proposals, compared with 22 for Tesseract, but took about 4.2 times the persistent Tesseract time. It recovered nine Tesseract review cases and lost two Tesseract successes. These results support a future selective fallback experiment rather than unconditional replacement.

All results use the inspected development corpus. Zero observed proposal errors is not an unseen accuracy estimate. Mandatory timestamp confirmation, physical-bottom/readability checks and version-bound approval remain active.

## Controlled setup

- Froze all 53 raw hashes and expected-label hashes before inference. The comparison rejects corpus drift and has no unseen test split.
- Ran engines sequentially in separate **linux/amd64 containers on an arm64 workstation under emulation**, each with a two-CPU quota and 8 GiB memory limit. These are not NAS performance measurements.
- Kept `reference-tiles-v2` input regions/copies and `timestamp-evidence-v2` parsing/evidence gates unchanged. No date-order or century policy was assumed.
- Used Tesseract **5.3.0** for both CLI and API paths, with identical installed language data. Built `tesserocr` **2.12.0** against the system library rather than a wheel with a different bundled Tesseract.
- Used RapidOCR **3.10.0**, ONNX Runtime **1.31.1**, and pinned **PP-OCRv6-small** detection/recognition models. The multilingual model covers the required script families; actual corpus field coverage remains limited.
- Capped OpenMP/ONNX/OpenCV work at two threads and OpenBLAS at one. RapidOCR used CPU execution only, no orientation classifier, and its detector's normal resize path. It does not use Tesseract page-segmentation modes.
- Downloaded and SHA-256-verified public model assets at image build time. Disabled container networking during all receipt inference. Expected dates/times and source-defect annotations reached only the scorer.
- Kept per-receipt text, boxes, TSVs, expected labels and model metadata under ignored `.receipt-samples/ocr-comparison-2026-11-03/`.

## Results

Latency covers decode and OCR for one receipt, including any profile/model initialization inside that receipt. Backend import time is separate. Each engine processed the same 53 receipts once; this is a first controlled run, not a repeated statistical performance study.

| Engine | Proposals | Correct date/minute | Review | Total seconds | Median seconds | P95 seconds | Peak sampled RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tesseract CLI | 22 | 22 | 31 | 148.7 | 2.22 | 6.16 | 239 MiB |
| Persistent Tesseract API | 22 | 22 | 31 | 97.1 | 1.35 | 4.21 | 404 MiB |
| RapidOCR / ONNX CPU | 29 | 29 | 24 | 410.9 | 5.97 | 17.80 | 1,740 MiB |

All three engines retained both expected source-review cases: missing transaction time and malformed printed seconds. Tesseract matched all 13 proposed seconds-bearing labels exactly. RapidOCR proposed 14 receipts with seconds-bearing labels: 13 matched exactly and one retained only supported minute precision. No wrong date/minute or incorrectly asserted seconds was observed; lower precision is reported rather than treated as recovered seconds.

The persistent API serialized the **same text, boxes, confidences and pass identifiers for all 53 receipts** as the CLI path. It did not improve OCR recall: both contained the correct date/minute somewhere in their candidate lists for 35 receipts. RapidOCR raised that diagnostic candidate count to 40; candidate presence alone does not permit a proposal.

The persistent profile cache had 39 fully warm receipts; other receipts needed at least one profile initialization or reload. Total measured profile initialization was about 2.63 seconds. Backend imports took about 0.06 seconds for the API and 1.07 seconds for RapidOCR, outside the table. The API emitted some native empty-region/clipping diagnostics but completed all passes and matched CLI output exactly.

### Memory interpretation

RSS is a 20 ms sample of the Python process plus child-process RSS. It includes persistent model/profile state and may count shared pages more than once. It is not unique physical memory consumption. Container `memory.peak`, which also includes other cgroup memory, was about 439 MiB for CLI, 657 MiB for API and 1,742 MiB for RapidOCR. Every run stayed inside the 8 GiB limit.

### Language-labelled proposal counts

Counts overlap. Many multilingual receipts use ASCII transaction fields, so these are corpus-label counts rather than proof of full language accuracy.

| Label | Samples | CLI / persistent API | RapidOCR |
| --- | --- | --- | --- |
| English | 48 | 20 / 20 | 25 |
| French | 3 | 1 / 1 | 2 |
| Japanese | 7 | 4 / 4 | 6 |
| Traditional Chinese | 3 | 1 / 1 | 1 |
| Simplified Chinese | 1 | 0 / 0 | 0 |
| Korean (additional label) | 1 | 0 / 0 | 1 |

The simplified-Chinese sample has malformed source seconds and correctly remains in review. The Korean-labelled example's timestamp is ASCII; its success does not expand the agreed OCR language scope. Real French month-name and Chinese transaction-field notation coverage remain gaps.

## The 31 Tesseract review cases

This table assigns one primary cause per receipt. A receipt can have additional issues. Date-policy issues take priority over generic incomplete-timestamp issues; known source defects are separate.

| Primary cause | Samples | Implication |
| --- | --- | --- |
| Date order / two-digit-year policy | 9 | Require explicit intake/layout conventions or reliable independent date evidence |
| No complete OCR timestamp | 7 | Better region recognition may recover faint/damaged text |
| OCR disagreement in a printed region | 3 | Keep competing readings; do not choose the minimum parse |
| Date/time association | 3 | Improve local context and source pairing |
| Incomplete timestamp | 2 | One field remains unsupported |
| Single directly parsed source | 4 | Retain evidence for confirmation; improve corroboration |
| Conflicting dates for equal clock minutes | 1 | Require a source check |
| Expected source defects | 2 | Keep missing time / invalid seconds in review |
| **Total** | **31** | |

RapidOCR's nine recoveries comprised four single-source cases, two OCR-conflict cases, and one each from missing OCR, association and date-conflict categories. It left all nine date-policy cases unresolved. Two previously successful Tesseract receipts no longer met the evidence gate with RapidOCR. The comparison did not use per-sample engine choices or expected labels to route OCR.

## Runtime change

The application image includes a source-built Tesseract API extension and sets `OCR_BACKEND=tesserocr`. One worker owns one bounded profile cache. Eviction calls `End`; shutdown releases the remaining APIs. Adaptive state and per-image buffers are cleared between passes. The parser, OCR copies, selected image master and approval rules are unchanged.

`OCR_BACKEND=cli` retains the earlier subprocess path for diagnostics. Native development defaults to CLI unless explicitly configured for the API. RapidOCR dependencies and model weights live in the separate benchmark image; production does not automatically download or select them.

## Repeatable comparison

Build the application image first, then the benchmark image:

```sh
docker build --platform linux/amd64 -t receipt-scanner:dev .
docker build --platform linux/amd64 -f Dockerfile.ocr-benchmark \
  --build-arg BASE_IMAGE=receipt-scanner:dev -t receipt-scanner:ocr-benchmark .
mkdir -p .receipt-samples/ocr-comparison-local
for backend in cli tesserocr rapidocr; do
  docker run --rm --network none --platform linux/amd64 --cpus 2 --memory 8g \
    --user "$(id -u):$(id -g)" \
    -v "$PWD/.receipt-samples:/corpus:ro" \
    -v "$PWD/.receipt-samples/ocr-comparison-local:/result" \
    receipt-scanner:ocr-benchmark --backend "$backend" \
    --samples /corpus --output /result --baseline /corpus/benchmark-v2 \
    --review-cases /corpus/review/extraction-review-cases.json \
    --hardware "describe the actual benchmark hardware"
done
```

Omit `--baseline` if prior private results are unavailable. Omit `--review-cases` if the source-defect annotation file is unavailable; a confirmed missing time still counts as expected review. Each engine writes its own `summary.json`. The common `cohort.json` freezes source and expected-label hashes. `--resume` validates the experiment fingerprint and supports an interrupted experiment; a resumed run is not a fresh continuous latency/memory measurement.

## Next measured step

Verification: **59 Python tests**, **3 application browser tests**, build/lint checks, and synthetic/real-long-receipt container checks pass. The production container check confirms the persistent API backend and the system Tesseract version. The approximately 881 mm PDF still has the correct physical size and exact original RGB pixels. All 159 comparison records were rescored; no OCR pass failed and CLI/API output equality holds for every sample.

Measure a selective RapidOCR fallback that preserves supported Tesseract proposals and runs only on unresolved candidates. Test combined runtime, memory and proposal errors rather than adding the standalone counts. Keep date-policy cases explicit. Obtain genuinely unseen receipt layouts before release evaluation and measure the selected path on the actual NAS.

## Upstream references

- [Tesseract API wrapper and ownership rules](https://github.com/sirfz/tesserocr)
- [RapidOCR source and configuration](https://github.com/RapidAI/RapidOCR)
- [Pinned RapidOCR model catalog](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml)
- `server/ocr_models.py` records the exact model URLs and SHA-256 values used in this comparison.
