# Receipt automation: concrete architecture proposal

Status: Architecture proposal with a [first application slice implemented](../application-runtime.md). Hardware-dependent acceptance remains partly open.
Date: 2026-10-11
Parent: [Epic](receipt-automation-epic.md)
Related: [Design](receipt-automation-design.md), [work items](receipt-automation-work-items.md)

## 1. Confirmed constraints

- Unraid 7.2.0, Intel Core i5-12500H, 64 GB RAM, no GPU. Reported average CPU use is below 20%; processing throughput remains to be measured.
- Mirrored 2 × 1 TB NVMe pool for application storage; 2 × 18 TB data disks plus parity for the archive.
- Container deployment behind existing Caddy and Authelia. Authentication belongs to that layer; no application accounts, passwords, or login sessions.
- Final deployment deliverable is a runnable amd64 Docker image and its port/volume/environment contract. The user handles NAS, storage placement, Caddy, and Authelia configuration.
- USB remains connected to the scanning workstation. Initially a MacBook Pro M1 Pro with 32 GB RAM; workstation-specific native software is not part of the application.
- Longest reported receipt is about 1,000 mm. The epsonds advertised-height handling has been patched; complete real captures reach about 881 mm. Physical verification near 1,000 mm remains open.
- Only transaction date and time are required extracted fields. Merchant/layout information is optional extraction assistance. Items, prices, totals, currency, and transaction references are deferred.
- When a receipt or related group contains multiple transaction timestamps, use the earliest supported complete date/time. Preserve all source timestamps and the selection reason.
- Combine receipts with the same date and exact minute by default unless there is clear evidence of different vendors. Every group still enters staging for correction and approval.
- A resolved time is mandatory for approval/upload. If groups cannot be merged, use a numeric `-{n}` filename suffix.
- The reviewed raw corpus now contains 53 captures spanning 2021–2026 and all five required language labels; physical receipts can be rescanned. See the [expanded review](receipt-sample-review-2026-10-25.md).
- The development sample app must scan directly on the workstation, without Docker. First-party Epson software does not provide raw originals for this purpose.
- Receipt languages: English, French, Japanese, traditional Chinese, and simplified Chinese. Receipt scanning began in 2021; do not treat that as proof that every physical receipt was issued after 2021.
- Use scanner-default DPI initially and verify resulting readability. Typical sessions contain 30–40 receipts. Enqueue processing immediately after durable receipt of each scan; aim for seconds-scale feedback, with slower difficult cases acceptable.
- Google Drive is the user's personal account and existing receipts folder shared with their wife; preserve that sharing.
- App-managed backups and backup restore are out of scope. Restart recovery, durable writes, and retryable Google Drive delivery remain in scope.
- Use OpenRouter or Ollama for LLM calls. New OpenCV procedure design uses GPT-6.1 Sol; routine model tasks use GPT-6 Luna or Claude Haiku 5.5.

## 2. Recommended stack

| Component | Choice | Reason |
| --- | --- | --- |
| Browser UI | TypeScript, Preact, Preact Signals, Vite | Builds on the existing signals usage; scan, staging, and sample tools share components. |
| Browser scanner | Pinned `sane-wasm`, initially investigate the current 0.5.0 build; WebUSB; serialized capture controller | Reuses working device access while isolating the long-scan investigation. Prefer a small reproducible backend patch if needed. |
| Browser persistence | IndexedDB via Dexie; bounded binary chunks plus capture manifests | Refresh-safe pending transfers without retaining a batch of full-height RGBA images in RAM. |
| API | Python 3.12, FastAPI, Pydantic 2, Uvicorn | Direct access to OpenCV, OCR, image formats, and schema-validated model output. |
| Database | SQLite, WAL, `synchronous=FULL`; SQLAlchemy 2 and Alembic | Fits a single-household service and avoids operating a separate database. |
| Jobs | SQLite job table, leases, bounded retries; separate worker process | Persistent jobs without Redis or a broker; image work cannot block the API event loop. |
| Images | `opencv-python-headless`, NumPy, Pillow with TIFF support | CPU processing, lossless masters, versioned deterministic recipes. |
| OCR | Native Tesseract 5 with `eng`, `fra`, `jpn`, `chi_tra`, `chi_sim`; word boxes/confidences | CPU baseline with language/script routing and mixed-script support; whole-receipt discovery followed by targeted recognition. |
| OCR comparison | RapidOCR with ONNX Runtime CPU | Benchmark a Paddle-derived detector/recognizer as a challenger; adopt only if samples show useful improvement. |
| Date/time extraction | Explicit candidate parsers and calendar validation; optional small-model fallback | Preserves ambiguity and source evidence across merchant formats. |
| LLM integration | Small provider adapter using `httpx`, OpenRouter default, Ollama optional | Direct structured requests; no orchestration framework needed. |
| PDFs | `img2pdf` for lossless embedding; `pikepdf` for composition/metadata | Binary, grayscale, or color images with DPI-based page sizes. Searchable text is deferred. |
| Google Drive | Google Drive v3 client and `google-auth` OAuth | Server-held refresh credentials, resumable upload, identity-based reconciliation. |
| Deployment | Debian-based multi-stage amd64 Docker image | Ship built UI, pinned assets, CPU dependencies, and language packs; document only the image's runtime interface. |
| Checks | pytest, Vitest, Playwright; Ruff and TypeScript checks | Backend fault tests, synthetic stream tests, and browser UI checks; real USB tests remain hands-on. |

Pin exact package versions, image digests, and model artifacts when building the first tested deployment. Version choices above specify the implementation baseline, not a claim that performance has been measured.

### Runtime topology

```text
Epson RR-70W --USB--> workstation Chrome/Edge
                          |
                    raw capture chunks
                    IndexedDB + retry queue
                          |
                      HTTPS, one origin
                          |
                 existing Caddy + Authelia
                          |
                receipt-app container
                ├── FastAPI + built UI
                ├── worker process + bounded child jobs
                ├── SQLite job/metadata database
                ├── OpenCV + Tesseract CPU
                └── Drive / OpenRouter clients
                    |                 |
              NVMe staging      approved PDFs on array

Optional existing/separate Ollama endpoint <-- provider adapter
```

One application container is sufficient initially. Use a process supervisor so API and worker failures are visible and restartable. Start with one heavy image/OCR job at a time, capped OpenCV/OCR thread counts, and a provisional 8 GB container memory limit. Increase to two workers only after measuring the actual CPU and interference with other NAS workloads. These are initial settings, not performance targets. Ollama is a separate optional service, outside that budget.

Each durably saved receipt immediately creates its own processing job. Keep OCR/model state warm where supported (for Tesseract, benchmark persistent `tesserocr` API instances) and reuse language profiles. There is no reason to wait for all 30–40 scans: warm engines and bounded workers provide reuse without batch-start latency. Regroup incrementally as timestamp evidence arrives. Measure first-receipt latency and sustained queue drain time separately; target seconds or tens of seconds for normal scans, while difficult long/multilingual scans or new recipe generation may take minutes. These are objectives, not measured promises. Batch-only processing would need a demonstrated throughput/resource benefit before changing the default.

## 3. Docker image runtime contract

The final image will expose HTTP on port `8000`, serve the UI/API/assets on one origin, provide health checks, persist jobs, and recover after restart. Document these volume interfaces; the user chooses their host placement:

| Container path | Suggested storage class | Contents |
| --- | --- | --- |
| `/state` | Local application storage | SQLite database/WAL, migrations, settings, protected Drive OAuth state/tokens. |
| `/work` | Fast application storage | Raw staging captures, candidates, temporary exports, thumbnails, OCR evidence. |
| `/samples` | Data storage | Pinned originals, expected labels, candidate manifests, reserved test corpus. |
| `/archive` | Data storage | Selected per-page lossless masters, approved PDFs, immutable export manifests. |

SQLite requires a local filesystem supporting locking and durability. Host paths and Unraid share/mover configuration belong to the user. The runtime contract includes `APP_PUBLIC_URL`, Drive OAuth client configuration, optional worker/thread limits, and `OPENROUTER_API_KEY`. The provider key is supplied only by environment variable, excluded from image layers/logs/browser assets, and needed only when external LLM features are actually used. Core capture, local OCR, staging, and export remain available with the LLM disabled.

Finalize files with checksum verification, file fsync, an atomic rename on the destination filesystem, and directory fsync. A move from NVMe to the array is a copy-to-temporary-file and finalize operation, not a cross-filesystem atomic rename. Only then commit the relevant database state. Recovery reconciles interrupted files and records; filesystem writes and database commits are not one atomic transaction.

Retain originals and every candidate through staging. Cleanup starts only after the approved masters, PDF, export manifest, and database approval are durable. It does not wait for Drive. Pinned samples survive cleanup. An unavailable/full array blocks approval finalization rather than losing staging data. Appdata and unapproved work must also survive container recreation.

## 4. Capture and 1,000 mm receipts

### Initial target

- Prove 1,000 mm at the measured scanner-default resolution first. Preserve default mode/DPI during baseline collection and check faint text and small Japanese/Chinese characters at full resolution before accepting production settings.
- Design byte/pixel limits with approximately 1,200 mm headroom, but advertise only the measured supported length.
- If default mode/DPI harms readability, choose a higher-quality supported setting based on samples; do not trade readability for speed. Other resolutions are separate benchmarks, not initial promises.
- Capability-check HTTPS, WebUSB, `SharedArrayBuffer`, `crossOriginIsolated`, and browser storage at startup.
- Desktop Chrome/Edge are the initial scan clients. Staging can support other modern browsers; Safari/Firefox are not initial USB scan clients. Future OS changes still require device-claim/release testing.

At 80 mm × 1,000 mm and 300 DPI, the image is approximately 945 × 11,811 pixels: 11.2 MP, 33.5 MB RGB, or 44.6 MB for one RGBA copy. At 600 DPI these amounts quadruple. A full 216 mm scanner-width image at 300 DPI is about 30.1 MP, so bounds must use actual scan width, not the usual receipt width. The present UI creates several image/canvas copies; workstation RAM alone does not remove canvas or WASM limits.

### Capture implementation

1. Inspect the exact backend/options/source revision behind the installed `sane-wasm` build. Compare long-paper behavior/settings with Epson's software if useful, but collect raw originals through the browser tool.
2. Trace returned parameters, bytes per row, status, row count, and EOF around 450, 500, 600, and 1,000 mm. Compare the physical receipt's bottom and measured length with the capture. Do not assume a reported EOF proves that the physical paper was fully captured.
3. Replace fixed `bytes_per_line * lines` allocation with bounded chunk accumulation, including SANE unknown-height (`lines = -1`) streams. Reject overflow, malformed partial rows, and unsupported frame formats explicitly.
4. Persist raw chunks and their manifest in IndexedDB; a partial capture is explicitly incomplete. Upload complete captures in resumable chunks, initially 4 MiB. A stable capture ID, numbered chunks, checksum, and finalize step make retries idempotent.
5. On the NAS retain the exact scanner bytes/settings as the original capture artifact. Decode to a lossless TIFF master with verified channel/bit interpretation; record that conversion separately. Imported unprocessed PNG/TIFF files remain unchanged originals.
6. Render bounded-height strips and downsampled previews rather than full-height capture canvases. Processing tiles have overlap appropriate to the recipe; OCR boxes map back to full-image coordinates and overlapping detections are deduplicated.
7. Serialize all USB operations. Use a dedicated capture worker only after verifying the library's worker compatibility; otherwise serialize on the main-thread controller. Request USB permission from a user action. A worker does not fix USB release by itself.

Investigate backend limits before committing to a driver change. Preferred outcome is an option or small SANE/WASM patch. A browser-native WebUSB protocol implementation is a contingency if the SANE path cannot support the device, with a larger maintenance cost. Either outcome retains the browser-only driver boundary.

## 5. Image processing and date/time extraction

Start with at most four versioned candidates per original: an unchanged/grayscale reference, conservative illumination correction plus contrast, adaptive Gaussian thresholding, and local Sauvola thresholding implemented using bounded OpenCV local-statistics operations. Deskew/crop share a tested geometry stage; the reference remains available. Do not port unconditional corner filling or aggressive trimming unchanged.

OCR first discovers date/time candidates across overlapping receipt strips. It then reruns candidate regions at original resolution on the reference and suitable enhanced image. Retain bounding boxes, snippets, engine/version, alternative parses, and coordinate transforms. OCR necessarily reads some surrounding text; structured extraction and approval require only date/time.

Bundle all five language packs in the Docker image. Route OCR using detected script, receipt labels, and known layout profiles rather than running all five recognizers on every image. Test mixed English/CJK receipts and allow manual language overrides. Include French month names, Japanese/Chinese year-month-day markers, locale-dependent numeric order, and Japanese era dates where samples require them. Compare the OCR challenger separately on each language; English-only results cannot establish multilingual accuracy.

Store local printed date and time separately, with precision, raw source text, source boxes, and unresolved alternatives. Do not manufacture a timezone. Support numeric orders, named months, 12/24-hour clocks, seconds, and older receipts. Per the 2026-11-07 workflow decision, routine new scans assume the current century for two-digit years. A persistent browser scan control permits a previous century or no assumption; each capture records the choice. Include the archive's 2021-onward scans without rejecting an older printed purchase date.

Select the earliest supported transaction timestamp as each receipt's canonical date/time and grouping key. Payment-terminal and cash-register timestamps are both eligible; neither source has priority over chronological order. Pair each time with its evidenced date/context and compare the complete date/time, retaining seconds where printed. Never independently select the earliest date and the lowest clock time from different candidates. Multiple genuine printed timestamps are resolved by this rule; ambiguous OCR interpretations, missing date/time, or unclear date/time associations still require staging review. Keep all candidates, source regions, and the reason `earliest_transaction_timestamp` alongside the selected value.

Only use the small-model fallback when parsing/context remains unresolved. Send relevant OCR lines or date-region crops, not a downscaled metre-long image by default. Validate its returned date/time and require source evidence; unsupported or competing interpretations remain unclear. The ordinary local path needs no LLM call.

### Optional layout memory

Persist a confirmed date-region location and layout signature after a correction. Start with OCR anchors and normalized geometric descriptors. A merchant name is optional metadata, not a required field or grouping key.

If repeated layouts justify embeddings, benchmark a quantized ONNX MobileNetV3 feature extractor on normalized header/layout crops, storing vectors and model versions with examples. Compare cosine similarity with NumPy at this corpus size; no vector database is needed. Test that date-region masking and layout features distinguish similar templates. A generic visual embedding is an experiment, not evidence that a date is correct. Weak matches fall back to full-receipt discovery.

## 6. Grouping, review, and export

Automatically combine receipts with the same resolved calendar date and minute unless evidence clearly identifies different vendors. Retain seconds as source metadata; differing seconds within that minute do not prevent the requested merge. Date-only receipts await time resolution in staging; manual field entry and grouping are always available. A tolerance across different minutes is a separate optional experiment, not the default.

For group naming, use the earliest supported complete transaction timestamp across its member receipts, including manually combined groups. Apply this to original/return groups as well; retain all later timestamps separately. Compare full timestamps before reducing the chosen value to minute precision for the filename. For example, register `2026-09-14 17:21` plus terminal `2026-09-14 17:24` uses `20260914-1721.pdf`. Across midnight, `2026-09-14 23:59` precedes `2026-09-15 00:01`.

Check the whole group for known vendor conflicts, so an unknown-vendor page cannot bridge two clearly different vendors. Merchant/header/logo evidence is an optional veto, not a required merchant-name extraction feature. Unknown vendor evidence does not prevent the default same-minute merge. Keep every page's source evidence, show the grouping reason, and permit manual split. Total/reference extraction remains deferred.

A return normally has a different date/time. Automatically link it only if a compatible original transaction timestamp is actually printed and extracted. Otherwise use manual combine; naming still follows the earliest supported member timestamp rule. Do not infer an original/return relationship from appearance.

All results enter staging, unclear first. Keep image readability, date/time ambiguity, and grouping reasons visible. Approval binds to an exact version of membership, fields, page order, and selected candidate images. Clear results still require selection and approval.

Create image PDFs using physical size from DPI; 1,000 mm is about 2,835 PDF points high. Test common viewers, and split presentation pages if needed while preserving every source row. Keep search text layers deferred.

Drive path remains:

```text
2026/09-September/20260914-1721.pdf
```

Preserve stable group/export IDs separately from this filename. Missing date/time blocks approval and upload until resolved in staging, including manual time entry when necessary; no exception invents midnight or scan time. Merge same-minute groups first under the vendor-veto rule. When separate groups cannot be merged, keep the first path unsuffixed and allocate `20260914-1721-1.pdf`, `-2.pdf`, etc. Reserve the lowest available positive suffix transactionally, persist it on the immutable export, and reuse it on retries; do not renumber prior exports or overwrite a pre-existing file. Show the final path before approval.

Use the existing personal Drive receipts folder as root and preserve inherited sharing with the user's wife. Use Drive file IDs/app properties for transfer identity and reconcile a successful upload with a lost response before creating another file. Check existing root/year/month files when allocating names; `drive.file` alone may not expose older files created outside this app. Validate selected-folder access and collision visibility during OAuth integration, adding read-only metadata scope if needed. Google tokens stay on the server. Later same-minute scans matching an approved group produce a staged revision requiring new approval; they never silently modify a shared PDF.

## 7. Application hosting boundary

The user configures Caddy, Authelia, HTTPS, networks, and host storage. The application image serves one-origin UI/API/assets, supplies browser isolation headers, and documents its external URL and forwarded-header requirements. No NAS/proxy configuration files or installation automation are part of this delivery.

On application responses supply:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: usb=(self)
```

Serve dependencies locally from locked builds. Test MIME types, WASM/worker URLs, and isolation at the container boundary; provide startup diagnostics so the user can check their own proxy. Auth expiry during upload leaves the durable browser queue pending and asks for reauthentication; it must not mistake an HTML login response for a save acknowledgment.

The app has no login system. Optional author attribution can use trusted proxy identity headers. State-changing APIs check `APP_PUBLIC_URL` and use JSON/non-simple requests. Document which headers may be trusted; the user owns the proxy trust boundary.

Use full-page Google OAuth redirects, with server-held state and callback validation, rather than a popup dependent on `window.opener`. Persist pending capture state before redirect and avoid leaving active scanner reads running during authorization. Document the required callback URL derived from `APP_PUBLIC_URL`.

## 8. Model routing

| Task | Default provider/model | Inputs |
| --- | --- | --- |
| Routine ambiguous date/time interpretation | OpenRouter `openai/gpt-6-luna` | OCR candidates and relevant context; crops when needed. |
| Routine alternative | OpenRouter `anthropic/claude-haiku-5.5` | Same validated extraction schema; compare sample accuracy/cost before selecting. |
| New OpenCV recipe design or substantial procedure revision | OpenRouter `openai/gpt-6.1-sol` | Original/candidate crops, quality failures, allowed operations, sample evidence. |
| Routine local option | Configured Ollama model, benchmarked independently | Prefer a small quantized text model for OCR interpretation; verify vision support if crops are sent. |

The OpenRouter public catalog listed these three requested model IDs during planning. Recheck capability, structured-output support, provider availability, and pricing when configuring credentials. Ollama is not assumed to host these proprietary model weights; it is an alternative provider using an available local model. On this GPU-less NAS, OpenRouter is the recommended default for LLM work. CPU Ollama throughput must be measured before making it part of the ordinary scan latency.

Do not request an OpenRouter key during sample collection or ordinary local development. Ask only when the first external model integration/test is actually ready, and read it from `OPENROUTER_API_KEY`; never request that the user paste the secret into chat or store it in source.

Use the same large/small task distinction for implementation work when those development tools are available. Routine application processing remains deterministic wherever possible; it does not need an LLM to perform uploads, group exact timestamps, or run an existing recipe.

Recipe generation returns schema-validated, allowlisted operations and bounded parameters. It does not return executable Python or replacement receipt pixels. Execute recipes in restricted child jobs with resource limits and no provider secrets/network; promote a recipe only after comparison on retained samples and a frozen test set. Record provider/model, recipe version, runtime, token cost, and outcomes. Store configurable per-request/monthly budgets and bounded retries. Provider settings identify what OCR text/crops can leave the NAS; selecting a provider alone does not define all data-transfer settings.

## 9. Sample mini-app and first implementation slice

A workstation development utility is implemented at [`sample-input.html`](../../sample-input.html), with [`sample-input.mjs`](../../sample-input.mjs), [`raw-scanner.mjs`](../../raw-scanner.mjs), and [`sample-server.py`](../../sample-server.py). It captures directly through WebUSB/SANE, records the backend defaults and frame diagnostics, retains original bytes before preview generation, autosaves ZIPs on the workstation, supports language/date/time/group labels, and exports checksummed manifests. Captures start unlabelled. See [sample capture instructions](../sample-capture.md).

The sample app runs without Docker, serves pinned local sane-wasm assets, and does not contact the NAS or an LLM. Scanner originals are `original.bin` plus the frame manifest; the display preview is separate. It also retains optional PNG/TIFF import and seeded synthetic generation, but first-party Epson exports are not the raw source. Raw capture has 256 MiB/160 MP limits and accepts unknown height; incomplete/error/cancelled streams retain received bytes and diagnostics. This does not remove an unverified backend length limit. The optional generator is limited to 20 MP/16,000 rows; its DPI is a synthetic-fixture setting, not a forced scanner setting.

To use it locally, run this from the repository directory and open `http://localhost:8000/sample-input.html`:

```sh
npm ci
python3 sample-server.py
```

Verification includes stream/fault tests, local-server durability checks, a simulated 40-receipt browser capture session with raw-byte/checksum verification, save/refresh/load, language labels, default-DPI metadata, full-resolution strip inspection, and pinned driver/WASM/worker initialization. The reviewed workstation corpus supplies physical scanning/readability evidence at 200 DPI, including about 881 mm; real 1,000 mm and USB lifecycle acceptance remain open.

Keep this as a workstation development tool; reuse its tested raw-capture concepts/modules in the final browser application. Later sample tooling improvements can:

- Capture unprocessed scanner data without running OpenCV; retain optional file import without depending on Epson exports.
- Show measured capture length, DPI, row/EOF diagnostics, completeness, and workstation save state.
- Let the user label exact date/time, ambiguous/unreadable/missing values, the date/time bounding boxes, expected group ID and page order, and conditions such as faded/skewed/long.
- Save a versioned manifest, original/checksum, scanner/browser settings, and expected labels. Export a downloadable bundle for local development.
- Mark a subset as reserved evaluation data and keep it out of tuning and recipe-generation inputs. Keep all private files outside Git.
- Generate seeded synthetic receipt images/stream fixtures for date formats, missing times, collisions, noise, tile boundaries, and 1,000 mm dimensions. Distinguish synthetic fixtures from real samples: they test plumbing, not scanner capability or real OCR accuracy.

Direct capture/workstation saving and the first application's durable transfer path are implemented. Visual bounding-box labelling and extraction accuracy benchmarks remain. A reported long-receipt jam prompted a [targeted epsonds patch](../../scanner-driver/README.md) using advertised `AMAX`, optional `PEDT`, a long profile at up to 300 DPI, and actual page-end height without padding. Diagnostic-only failures survive even when no pixels return. Complete physical captures above 508 mm are present in the reviewed corpus. A first-read stall was observed with sane-wasm's built-in test backend during an earlier experiment; discovery/open/close succeeded. The utility exposes cooperative recovery rather than promising cancellation of a stalled WASM call.

Start with 30–50 real receipts across approximately 8–10 layouts, including readable old/faded receipts and several related pairs. Aim for 80–100 before setting accuracy thresholds, with a reserved portion split by layout and receipt condition. Keep matched pairs together within a split; reserve some unseen layouts to measure generalization. Include receipts around 450, 500, 600, and 1,000 mm where available. Labels can be unresolved; readable and unreadable samples measure different things.

## 10. Delivery and verification

1. Capture and label real originals with the workstation tool; check default-DPI readability across all five languages (RA-01).
2. Trace USB recovery and the 500 mm boundary; reproduce and patch the limiting layer, then prove the 1,000 mm capture target (RA-02, RA-03, RA-06, RA-07).
3. Ship a vertical slice in the final Docker image: resumable upload, durable storage/jobs, manual staging/grouping, readable PDF, selected approval, Drive delivery, cleanup (RA-08–10, RA-14, RA-16–18, RA-21). The user handles host/proxy deployment.
4. Benchmark CPU OCR and conservative recipes; add evidence-backed date/time extraction, timestamp grouping, corrections, and run history (RA-05, RA-11–13, RA-15, RA-20, RA-22).
5. Add on-demand Sol recipe proposals if baseline failures justify them (RA-23). Validate restart, quota/disk-full, proxy reauthentication, stale approval, interrupted uploads, cleanup, and actual USB lifecycle before release (RA-19).

Docker/Buildx supplies amd64 release builds; benchmark on the actual x86 hardware rather than drawing throughput conclusions from Apple Silicon emulation. Emscripten plus the sane-wasm build toolchain is needed if a backend patch is required. The sample application itself uses a local Python server without Docker. Browser DevTools and structured diagnostics are the initial USB investigation tools. Playwright covers UI/retry behavior, not proof of physical USB release or scanner length.

## 11. Inputs and access that would help

- Preferred Chrome/Edge version and whether Chrome is acceptable on the present Mac. USB VID/PID and selected SANE backend/options from a diagnostic run.
- A short hands-on session collecting raw ZIPs across English, French, Japanese, and both Chinese scripts, including the longest receipt and confirmation of its physical bottom/default readability.
- Actual merchant date conventions where ambiguous, and whether some physical receipts predate the 2021 start of scanning.
- Existing Drive root folder ID and OAuth setup when Drive integration begins. Earliest complete transaction timestamp, mandatory time, same-minute merge/vendor veto, and numeric suffix rules are confirmed.
- An acceptable model budget/data setting when external model testing begins. At that point ask for `OPENROUTER_API_KEY` to be set in the environment. No key is needed for this sample tool.

Implementation uses repository tools, locked Node/Python dependencies, Docker/Buildx, browser diagnostics and the reproducible Emscripten driver build. The first amd64 image passes isolated recreation and real-sample PDF pixel-preservation checks. NAS throughput, live Drive authorization, physical USB lifecycle and near-1,000 mm capture still require deployment/hands-on measurements. No NAS configuration or model-provider secret is needed for the local slice.

## References checked during planning

- [sane-wasm source, build process, and API boundary](https://github.com/goncalomb/sane-wasm)
- [WebUSB capabilities and browser support](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API)
- [Authelia's Caddy forward-auth integration](https://www.authelia.com/integration/proxies/caddy/)
- [OpenRouter model catalog](https://openrouter.ai/api/v1/models)
- [PaddleOCR project](https://github.com/PaddlePaddle/PaddleOCR), as background for the CPU OCR comparison.
