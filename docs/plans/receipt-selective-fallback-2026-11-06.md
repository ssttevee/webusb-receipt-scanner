# Selective local OCR fallback

Date: 2026-11-06

Related: [CPU comparison](receipt-ocr-comparison-2026-11-03.md), [runtime contract](../application-runtime.md), RA-05 / RA-10 / RA-12 / RA-13.

## Result and delivery

The combined path proposes **31 matching date/minute values from 53 receipts** and leaves **22 in review**. It preserves every supported Tesseract proposal and adds nine RapidOCR recoveries. All 16 proposals with seconds-bearing labels match those seconds. Both expected source-review examples remain unresolved. No wrong date/minute or asserted seconds was observed on this inspected development corpus.

The optional **`receipt-scanner:ocr`** application image enables this path. It includes pinned local model assets and the same application/volume contract as `receipt-scanner:dev`. The smaller `:dev` image retains the fast persistent Tesseract path. Every proposal still requires Save review and explicit approval. Neither result establishes unseen accuracy or NAS performance.

## Routing policy

`selective-fallback-v1` uses only primary extraction results:

1. Preserve a supported primary timestamp exactly. Do not start the fallback child for that receipt.
2. Keep unresolved numeric date order or two-digit-year policy in manual review.
3. Keep invalid calendar/clock/suffix evidence in manual review.
4. Run RapidOCR only for the remaining unresolved receipts.
5. Accept a secondary proposal only when it independently passes the unchanged timestamp evidence gate and completes its OCR passes.

The router never forms a timestamp from a primary date and a secondary clock. It never selects the minimum across conflicting engine interpretations. An accepted fallback proposal retains both engine candidate/source lists and the primary review reasons. A failure or timeout leaves the original primary evidence and unresolved fields available for manual review.

The policy uses no expected labels, per-receipt engine choices, merchant identities or source-defect annotations. Those annotations reach only the scorer.

## Fresh combined measurement

All 53 corrected sources and label hashes match the frozen comparison cohort. Tesseract 5.3.0, its data files, RapidOCR 3.10.0, ONNX Runtime 1.31.1, the PP-OCRv6-small hashes, OCR copies and parser policy match the earlier comparison. The parent uses persistent Tesseract; a separate persistent child owns RapidOCR.

The fresh run used an amd64 container under emulation on the arm64 workstation, a two-CPU quota and 8 GiB memory limit. Network access was disabled during inference. It includes fallback-child startup, image handoff, inference and evidence transfer. Earlier standalone measurements are comparators from a separate run, not simultaneous NAS measurements.

| Measurement | Combined result |
| --- | --- |
| Receipts | 53 |
| Proposed / manual review | 31 / 22 |
| Proposal coverage | 58.5% |
| Preserved primary proposals | 22/22, identical selected values |
| Fallback attempts | 21 |
| Additional supported proposals | 9 |
| Fallback without a supported proposal | 12 |
| Policy/invalid-source skips | 9 / 1 |
| Observed wrong date/minute or asserted seconds | 0 |
| Exact seconds for proposed seconds-bearing labels | 16/16 |
| Total decode/OCR/handoff time | 305.1 seconds |
| Median / P95 receipt processing | 2.23 / 18.86 seconds |
| Median processing for preserved primary-success receipts | 1.12 seconds |
| Peak sampled process-tree RSS | Approximately 1,966 MiB (1.92 GiB) |
| Container memory peak | Approximately 2,016 MiB (1.97 GiB) |
| Timeouts / failed fallback calls in the fresh run | 0 / 0 |

The earlier persistent-only run took 97.1 seconds and proposed 22 values; standalone RapidOCR took 410.9 seconds and proposed 29. The combined run actually preserved the two Tesseract successes that standalone RapidOCR lost. These counts come from live combined execution, not a union of saved predictions.

All 21 child requests confirmed Linux resource enforcement. Fallback work took 195.2 seconds total, with median 6.69 seconds and P95 24.26 seconds. Processing measurements exclude browser transfer and queue wait. A slow fallback job can delay later receipts in the single-worker queue.

### Remaining review cases

| Primary category | Count |
| --- | --- |
| Date policy | 9 |
| No supported OCR timestamp | 6 |
| Association | 2 |
| Incomplete timestamp | 2 |
| OCR conflict | 1 |
| Expected source defects | 2 |
| **Total** | **22** |

Language-labelled proposal counts are English 27/48, French 2/3, Japanese 6/7, traditional Chinese 1/3, simplified Chinese 0/1, and Korean-labelled 1/1. Counts overlap; many multilingual timestamps are ASCII. The malformed-seconds simplified-Chinese case correctly stays in review. The Korean-labelled result does not expand the required OCR language scope.

## Deadline, memory and recovery

- The fallback runs in a spawned process, so native ONNX work does not block the API process or share Tesseract state.
- The parent enforces a **45-second deadline** from child startup/request through the completion acknowledgment. It terminates and reaps the child on timeout or protocol failure. Result validation and process teardown add a small amount outside that inference deadline.
- Linux imposes a **4,096 MiB virtual-address-space cap** and a per-request CPU allowance. This is not a 4 GiB RSS allowance. The application container keeps its separate 8 GiB limit.
- Linux binds child lifetime to worker lifetime with a parent-death signal. A forced worker exit terminates its inference child.
- A small IPC message supplies a durable master path. A size/checksum-bounded private JSON result file carries evidence; large images/results do not block a pipe transfer.
- Model setup and telemetry disablement occur before the child receives a receipt path. The child removes Drive/OpenRouter credential variables from its environment. Runtime inference uses local verified model files.
- The worker owns one child and reuses it. After timeout/failure, the next eligible receipt starts a fresh child. The failed receipt remains in manual review; there is no silent retry loop.

## Build and use

```sh
docker build --platform linux/amd64 -t receipt-scanner:dev .
docker build --platform linux/amd64 -f Dockerfile.ocr -t receipt-scanner:ocr .
```

Use `receipt-scanner:ocr` in the existing application run command, with the same persistent mounts, public URL, UID/GID and port. It sets `OCR_FALLBACK=rapidocr`. Set that variable to `none` to use only the primary engine. The smaller image defaults to `none`; it does not contain RapidOCR dependencies/model files.

| Variable | Enhanced image default |
| --- | --- |
| `OCR_FALLBACK` | `rapidocr`; allowed values `none`, `rapidocr` |
| `OCR_FALLBACK_TIMEOUT_SECONDS` | `45`; range 1–120 |
| `OCR_FALLBACK_MEMORY_MIB` | `4096`; Linux address-space range 1024–6144 MiB |
| `RAPIDOCR_MODEL_DIR` | `/opt/receipt-ocr-models`; files must match pinned hashes |

The UI identifies fallback proposals, primary issues and fallback failures. Both source branches link to full-resolution image strips. Confirmation, grouping versions, filename reservations, archive commits, Drive selection and cleanup retain the existing rules. No database migration is needed; extra evidence stays in the existing JSON field.

## Repeat the combined experiment

Build `Dockerfile.ocr-benchmark` with the current `:dev` image, then run the previous comparison command with `--backend hybrid` and a new private output directory. Optional `--fallback-timeout` and `--fallback-memory-mib` parameters define the child bounds. Keep default date-order/century policy and the same cohort for a controlled comparison. Each output retains its experiment fingerprint; diagnostic changes after a completed run do not create a new timed result.

## Next measured work

Verification: **74 Python tests**, **4 application browser tests**, TypeScript/Vite and lint checks pass. Live enhanced-image checks cover a real fallback recovery and a forced one-second deadline, including child termination, retained staging, explicit manual confirmation, container recreation and exact PDF pixels. The timeout case uses the approximately 881 mm raw sample. Source lists render both branches as escaped text and link to original-resolution strips.

Confirm explicit date conventions for the nine policy cases through user-approved intake/layout settings. Improve the remaining difficult source regions while retaining originals and rejected candidates. Obtain genuinely unseen layouts and measure the selected image on the actual NAS before release accuracy/latency claims.
