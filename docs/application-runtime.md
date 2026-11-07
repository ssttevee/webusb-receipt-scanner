# Application runtime: capture-to-staging and timestamp proposals

## Implemented boundary

The application serves a TypeScript/Preact/Vite UI and FastAPI API on one origin. It reuses the tested raw scanner controller and `receipt-longpaper-2` WASM driver. Browser captures are stored in IndexedDB before transfer, uploaded in checksum-acknowledged 4 MiB chunks, and removed from the pending queue only after a matching durable final acknowledgment. A failed/login-page acknowledgment leaves the browser copy pending. Partial scanner failures remain downloadable in browser diagnostics and do not enter the complete-receipt API.

Each durable receive immediately queues processing. A separate worker creates a lossless TIFF reference master, preview, bounded OCR regions and timestamp proposals. It reads no expected sample dates/times. The OCR path uses original grayscale discovery plus overlapping 1,600-row contrast copies; boxes map to the original image. The reference master stays unchanged.

Supported proposals prefill date/time fields and may form same-minute staging groups. Each proposal needs direct agreement from two OCR passes or repeated printed regions. Calendar validation, source context and conflicting evidence can still require manual review. This is an evidence gate, not a correctness probability. Inspect the candidate text and source strips, then choose **Save review** to confirm/correct the fields. Approval rejects an unconfirmed OCR proposal even if date/time and image checkboxes are present.

Saving reviewed fields automatically combines staged receipts with the same date/minute unless known vendor hints conflict. Unknown hints permit merging; group-wide checks prevent an unknown page bridging two different vendors. Optional hints are exact case-insensitive values, not an implemented visual merchant classifier. Select pages in the desired order and choose **Make selected pages a manual group** to combine or split a subset. Move up/down changes page order and marks grouping manual, preventing immediate automatic remerge.

**Prepare approval** reserves and displays the final path. **Approve this version** freezes membership, fields, order and reference images. The worker copies selected masters to the archive filesystem, writes PDF and immutable manifest, verifies checksums, then commits approval. Original/chunk/reference working copies are deleted by a separate durable cleanup job only after that commit. Small previews, OCR and capture metadata remain available; `.receipt-samples/` and `/samples` are not touched. Cleanup does not depend on Drive.

Local and visible Drive collisions use the first available stable `-1`, `-2`, etc. reservation. A file appearing after reservation is preserved and causes a reviewable delivery/finalization failure. It is never overwritten. A retry reuses existing verified export bytes, including after a crash between PDF finalization and database commit.

If Drive is offline during path preparation, the UI records that its collision check was unavailable. Local approval/download/cleanup still work; delivery rechecks the filename before creating a remote file.

This slice has one reference master, automatic timestamp proposals, mandatory confirmation and immutable approved exports. The [CPU OCR comparison](plans/receipt-ocr-comparison-2026-11-03.md) selects persistent Tesseract for the Docker worker. Improved OCR recall, image enhancement/ranking, production sample pinning, approved-group revisions, batch approval and richer cleanup policies remain planned. It does not satisfy all RA release acceptance checks.

The optional `receipt-scanner:ocr` image adds a [measured selective RapidOCR fallback](plans/receipt-selective-fallback-2026-11-06.md). It preserves supported primary proposals and retains policy/invalid-source cases for review. A bounded child process handles other unresolved receipts. The inspected-corpus result is 31 matching proposals and 22 review cases; unseen accuracy and NAS throughput remain open.

The Docker worker retains at most three Tesseract language profiles. It clears adaptive state and image buffers between passes and releases profiles on eviction/shutdown. The API extension uses the same system Tesseract 5.3.0 library and language data as the CLI. Corpus OCR text/boxes and timestamp proposals match the earlier path exactly; measured emulated-workstation runtime fell by about 35%.

### Timestamp policy and evidence

The parser supports English/French month names, numeric dates, Japanese/Chinese year-month-day markers, Japanese era dates, hour/minute markers, AM/PM and seconds. It selects the earliest supported complete timestamp, preserving precision and every source candidate. Scheduled visits, business hours and coupon contexts are excluded; arbitrary reference digits are not trusted timestamp evidence. Invalid printed seconds, unresolved date associations and OCR disagreements require review.

Ambiguous numeric order stays unresolved unless independent printed evidence resolves it or `DATE_ORDER` explicitly defines the intake convention. Two-digit years need `TWO_DIGIT_YEAR_CENTURY`; the application does not silently add 2000. Leave both settings unset for a mixed archive unless a convention is valid for that intake. Missing seconds remain minute precision. No missing field becomes midnight or scan time.

Evidence includes extractor/recognizer versions, parser policy, raw OCR lines, original-coordinate boxes, OCR tool scores, selected candidate/reason and unresolved alternatives. Tool scores are not measured date accuracy. New captures use this path; existing manually reviewed fields remain intact.

### Receipt-local conventions and reanalysis

Open **Date convention & reprocess** on a staged receipt. Choose numeric order and century, use application defaults, or explicitly choose No assumption. **Apply convention to saved OCR** creates a fast cached reparse; **Run OCR again** creates a fresh recognition run with the same master. Each choice applies only to that receipt and is recorded in analysis history. See the [policy-assisted experiment](plans/receipt-convention-reanalysis-2026-11-06.md) for results and their manual-input scope.

The API snapshots effective settings when the run is queued. A later environment change does not reinterpret a pending user request. Old evidence remains inspectable. New runs invalidate reserved approvals; active work blocks approval. Stale runs and lost job owners cannot publish over newer analyses or manual fields. A failed reanalysis leaves the image and last evidence available for manual resolution. Unsaved local field edits disable preparation/approval until saved or reloaded.

## Image contract

- HTTP port: **8000**. No application login; existing external authentication is the deployment boundary.
- `APP_PUBLIC_URL` is the exact browser origin without a path or trailing slash, e.g. `https://receipts.example.net`. Host and mutating Origin checks use it. Development `localhost` and `127.0.0.1` are different origins.
- Responses supply COOP `same-origin`, COEP `require-corp`, CORP `same-origin` and USB `self` permissions. UI, WASM and workers are served locally. Forwarded headers do not redefine the public origin.
- UID/GID: **10001:10001**. Bind mounts must be writable by that identity. Fresh named volumes inherit image ownership.
- One application instance, one API and one heavy worker per database. The supervisor terminates the container if either child exits. The image health check probes the API and worker heartbeat.
- Initial memory budget: **8 GiB**. OCR/OpenMP threads are capped at two; OpenBLAS at one. Workstation/emulated-container timings do not establish NAS throughput.
- Raw API: complete final 8-bit RGB or grayscale frames, up to **256 MiB / 160 MP**, full rows, actual dimensions and 50–1,200 DPI metadata. Unsupported raw formats stay in the browser pending queue; the collector can retain broader diagnostic formats.
- Import API: single-page opaque 8-bit RGB/grayscale PNG/TIFF. The browser convenience importer accepts PNG at an explicitly displayed 200 DPI. Use raw capture to preserve actual scanner DPI. This slice applies no geometric trimming, deskew or thresholding.

| Mount | Contents |
| --- | --- |
| `/state` | SQLite database/WAL (schema version 3), analysis run policies/history, OAuth state, protected Drive refresh token, worker heartbeat |
| `/work` | Pending chunks/originals, reference TIFFs, previews, private OCR/evidence |
| `/samples` | Reserved for pinned production samples; this slice does not populate it |
| `/archive` | Approved PDFs in year/month paths; `.exports/{id}/` holds selected masters, PDF bytes and immutable manifest |

Use a local locking/durability-compatible filesystem for `/state`. Preserve mounts across container recreation. Host storage, Caddy and Authelia setup belong to the deployment owner. Database transitions use SQLite WAL, `synchronous=FULL`, foreign keys and explicit transactions. Schema 3 migrates from schema 1/2 and adds receipt analysis versions and immutable run references. Existing complete manual fields retain confirmation; legacy evidence is snapshotted before its first explicit reanalysis. Older schema-only images cannot open schema 3. SQLAlchemy/Alembic adoption remains a later decision.

Files use temporary writes on the destination filesystem, fsync, finalization and directory fsync. Archive writes never rely on a cross-mount atomic rename. Ready exports and master checksums are rechecked before cleanup/delivery. App-managed backups are outside application scope.

### Environment

| Variable | Default / purpose |
| --- | --- |
| `APP_PUBLIC_URL` | `http://localhost:8000`; exact public origin |
| `OCR_ENABLED` | `1`; `0` retains manual staging without OCR |
| `OCR_BACKEND` | Docker: `tesserocr`; native: `cli`. Both paths require explicit timestamp confirmation |
| `TESSDATA_PREFIX` | Docker: `/usr/share/tesseract-ocr/5/tessdata`; native API mode needs the actual installed data directory |
| `OCR_FALLBACK` | `none` in `:dev`; `rapidocr` in the optional `:ocr` image |
| `OCR_FALLBACK_TIMEOUT_SECONDS` | `45`; 1–120 seconds for child startup/inference/acknowledgment |
| `OCR_FALLBACK_MEMORY_MIB` | `4096`; Linux child address-space cap, range 1024–6144 MiB |
| `RAPIDOCR_MODEL_DIR` | `/opt/receipt-ocr-models`; enhanced image includes verified assets |
| `DATE_ORDER` | Unset; optional `MDY`, `DMY` or `YMD` for an explicitly known intake convention |
| `TWO_DIGIT_YEAR_CENTURY` | Unset; optional `1900` or `2000`; no implicit century |
| `DRIVE_CLIENT_ID` | Optional Google OAuth web client ID |
| `DRIVE_CLIENT_SECRET` | Optional server-side OAuth secret |
| `DRIVE_ROOT_ID` | Existing personal Drive receipts folder ID |
| `STATE_DIR`, `WORK_DIR`, `ARCHIVE_DIR` | `/state`, `/work`, `/archive`; mainly useful for native development |
| `PORT` | `8000`; native development only; Docker health check expects 8000 |

The core workflow needs neither Drive credentials nor an OpenRouter key. No external-model integration is active in this slice.

## Google Drive

1. Configure a Google OAuth **Web application** client with callback `${APP_PUBLIC_URL}/api/drive/callback` and enable Drive v3 for the project.
2. Supply the three `DRIVE_*` environment variables and retain `/state`. Use the existing shared receipts folder as root.
3. Disconnect the scanner, then choose **Connect Google Drive**. The browser uses a full-page redirect. OAuth state is single-use and expires after ten minutes. The server validates that the existing root is writable.
4. Approve a group locally, then explicitly choose **Send approved PDF to Drive**. No staging item is automatically uploaded.

This adapter requests the full Drive scope because it must see collisions and create files beneath pre-existing folders not selected through a Drive Picker. Authorization is account-wide; the application routes its own operations beneath the configured root. Folder IDs, export identity and checksums provide retry reconciliation. It does not change permissions or sharing; new children inherit the existing folder's sharing. Refresh credentials stay in `/state/drive-token.json`, mode 0600, and are never sent to the browser. API access logs exclude callback query strings and receipt bodies.

Delivery jobs retry with bounded backoff. After a successful upload with a lost response, retry searches the stable export app property before creating anything. Conflicting existing names or multiple matching identities fail rather than overwrite. Resolve an external filename conflict in Drive before retrying the immutable export. Live Google authorization/delivery requires the user's OAuth configuration and has not been verified against their account; automated tests use a simulated provider.

## Native development

Use Python 3.12 and Node 22. The application and collector are separate servers; stop one before reusing its port.

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements.lock
.venv/bin/python -m pip install pytest==8.4.2
npm ci
npm run build:app
APP_PUBLIC_URL=http://localhost:8000 \
  STATE_DIR="$PWD/.app-data/state" WORK_DIR="$PWD/.app-data/work" \
  ARCHIVE_DIR="$PWD/.app-data/archive" OCR_ENABLED=0 \
  .venv/bin/python -m server.run
```

Native OCR needs Tesseract and the selected packs installed. Native API mode additionally needs `tesserocr`; its wheel may bundle a different Tesseract version. The Docker image builds the extension against its own 5.3.0 library and includes all five packs, so workstation-native OCR packages are not a deployment dependency. Headless simulated-device checks are not physical-scanner proof.

## Checks and recovery

```sh
.venv/bin/python -m pytest tests/test_application.py tests/test_drive.py tests/test_extraction.py tests/test_ocr_comparison.py tests/test_ocr_fallback.py tests/test_reanalysis.py -q
npm run test:samples
npx playwright install chromium
APP_TEST_PYTHON="$PWD/.venv/bin/python" npm run test:app-browser
npm run test:scanner-browser
.venv/bin/python scripts/check-container.py --image receipt-scanner:dev
```

`scripts/check-container.py --bundle .receipt-samples/sample-{uuid}.zip` also tests a private real raw sample. It creates isolated uniquely named containers/volumes, recreates the container during an interrupted upload and after approval, checks the five OCR packs, and verifies embedded PDF RGB pixels against the original. Test volumes are removed afterward; source bundles remain unchanged. This checks durability/pixel preservation, not extraction accuracy or NAS throughput.

- **Pending transfer:** reconnect/authenticate and Resume transfers; reload also resumes. Keep site storage while copies are pending.
- **Scanner fault:** partial bytes/diagnostics remain downloadable. Stop waits cooperatively for the current driver operation; disconnect/reconnect when recovery is requested.
- **Browser storage failure:** intake stops and retains the current capture in memory for download. Save it before closing the tab; memory cannot survive browser termination.
- **Restart:** pending jobs survive. Expired leases are reclaimed and heartbeats renew active work. Replays after committed decode/finalized PDF reuse verified artifacts.
- **Failed processing/approval/Drive:** originals remain through unsuccessful approval; Retry in Background jobs after addressing the cause. Drive outages leave approved files local.
- **Stale editor/approval:** reload the latest review; stale submissions are rejected. Approved/finalizing groups are read-only in this slice.

## Verification snapshot

Backend fault-path tests and browser end-to-end checks cover lost acknowledgment/reload and production-UI capture through the compiled driver against simulated Epson USB. The amd64 image builds and passes isolated recreation/OCR/approval/PDF checks with a real approximately 881 mm capture, whose embedded pixels match the raw original. Physical USB lifecycle, approximately 1,000 mm real capture, NAS throughput, live OAuth and the broader RA acceptance matrix remain hands-on/follow-up checks.

The [extraction baseline](plans/receipt-extraction-baseline-2026-11-03.md) records corpus measurements and the repeatable benchmark command. The browser suite includes a native Tesseract proposal/source-strip check when Tesseract is installed. Python checks cover parser edge cases, proposal confirmation, automatic grouping, schema migration, stale approval, deletion and recovery. No live Drive account or external model was contacted.

The persistent-API increment passed **59 Python tests** and **3 application browser tests**. Its container checks verify the persistent backend, version, restart recovery and exact real-receipt PDF pixels. Tests include profile reuse/reset, coordinate mapping, checksum and cohort-drift cases. The comparison report retains the measured 53-receipt engine results and emulated-hardware limits. Existing collector stream/server checks passed in the preceding application slice; raw capture does not change in this increment.

The selective-fallback increment passes **74 Python tests** and **4 application browser tests**. Its enhanced-image checks verify a real recovery and forced deadline/child termination, followed by manual approval and exact source-pixel PDF checks. These checks use disposable volumes and preserve the private input bundles.

The current convention/reanalysis increment passes **89 Python tests** and **5 application browser tests**, with schema migration, lease/supersede, manual-edit preservation and unsaved-field approval checks. Live real-sample scenarios validate cached parsing, fresh recognition, AM/PM fallback recovery, immutable history and exact PDF pixels.
