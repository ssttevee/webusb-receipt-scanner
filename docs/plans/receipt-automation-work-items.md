# Receipt automation work items

Parent: [RA epic](receipt-automation-epic.md)
Design: [Design and decisions](receipt-automation-design.md)
Stack and confirmed constraints: [Concrete architecture](receipt-automation-architecture.md)

The sample-input utility under RA-01 and a [first application slice](../application-runtime.md) are implemented. The latter covers durable uploads/jobs, reference masters/OCR evidence, manual staging/grouping, approved PDFs/cleanup and an optional Drive adapter; broader acceptance matrices remain open. All clear and unclear results must enter staging before Drive upload. Only user-approved, selected items or groups can be uploaded. RA-23 is optional and is not a release condition.

Size is a planning guide, not a delivery estimate:

- S: one focused change or report.
- M: several related changes with tests.
- L: split into smaller implementation tasks after the stated research.

## RA-01 — Build the receipt test set and baseline

Type: Research and tests. Size: M. Depends on: None.

Progress: [`sample-input.html`](../../sample-input.html) and `sample-server.py` provide direct WebUSB raw capture, defaults/applied-profile diagnostics, browser/workstation saves, date/time/language/group labels, ZIP manifests, and optional image import/synthetic fixtures. See [sample instructions](../sample-capture.md). Stream and local-server tests pass; region annotation and validated baseline evaluation remain. The development app runs without Docker or a NAS connection.

Corpus update: the [expanded sample review](receipt-sample-review-2026-10-25.md) covers 53 real captures, including a complete replacement for the clipped return and saved corrections from both review rounds. All originals pass checksum/row checks, all have physical-bottom confirmations, all labels are now confirmed, and labelled coverage includes every year from 2021–2026 and all five required languages. The severely faded date has user confirmation; missing-time and malformed-source cases remain explicit tests. A reserved split, targeted language/date-notation gaps, and validated extraction benchmarks remain.

Work:
- Collect permitted samples: clean, faded, damaged, skewed, blank, incomplete, and long receipts.
- Use the direct-scanner workstation collector for real raw samples; first-party Epson output is not a raw source. Preserve readable backend defaults and record DPI, frame parameters, read/EOF status, and physical-bottom checks. Keep synthetic fixtures separate from real OCR/scanner evaluation.
- Cover English, French, Japanese, traditional Chinese, and simplified Chinese, including mixed-script receipts and the archive scanned since 2021. Include a 30–40 receipt session.
- Include new merchants, multiple dates, ambiguous numeric dates, missing years, missing times, filename collisions, and poor scans.
- Label the earliest supported complete transaction timestamp when a receipt has several; include cash-register/payment-terminal ordering differences, different minutes, differing seconds, and timestamps spanning midnight. Keep the other timestamps as source notes/evidence.
- Include itemized receipts with payment terminal receipts, original receipts with multiple returns, unrelated similar receipts, and groups with mixed page quality.
- Keep private receipt images out of public source control and routine logs.
- Label purchase and return dates/times, source regions, expected groups and page order, relevant visible text, image defects, and whether a person can read the receipt. Date/time are the only required extracted fields.
- Keep permitted test samples separate from normal receipt storage. Pin bad sample originals and all procedure results before approval under RA-21.
- Keep a separate test set that is not used to tune rules or select examples.
- Record current accuracy, manual actions, processing time, and scanner settings.

Acceptance:
- A versioned sample manifest and repeatable test command exist.
- Each sample has expected results or an explicit unresolved label.
- The report includes sample counts, merchant coverage, and current failures.
- Required fields, supported languages, and proposed release thresholds are recorded.

## RA-02 — Identify USB ownership and recovery behavior

Type: Research. Size: M. Depends on: None.

Work:
- Record the browser, operating system, device identity, SANE backend, and WASM build.
- Trace open, start, read, cancel, close, and USB disconnect operations without logging receipt data.
- Reproduce refresh during idle, start, read, and completion. Test tab close, crash, a second tab, and cable removal.
- Check whether the current promise race leaves a SANE or USB operation running.
- Compare short open/poll/close cycles with a dedicated capture worker. Verify API support before choosing either design.

Acceptance:
- A reproduction report identifies what owns the device at each failure point.
- The report separates verified behavior from suspected causes.
- A supported recovery sequence and browser/OS test matrix exist.
- No design depends on asynchronous unload work completing. A worker alone is not accepted as a release guarantee.

## RA-03 — Locate the long-receipt limit

Type: Research. Size: M. Depends on: None.

Progress: Epson documents a jam above 508 mm without long-paper settings. The pinned epsonds backend discards advertised `AMAX`; an [experimental backend patch](../../scanner-driver/README.md) and collector profile now expose that larger height, use advertised paper-end detection, and preserve actual page-end rows. Compiled-WASM tests with a simulated Epson USB device verify the length-related jam path, successful 1,000 mm data, and missing-row rejection. The [expanded real corpus review](receipt-sample-review-2026-10-25.md) includes complete physical captures at approximately 631, 644 and 881 mm. Physical verification near 1,000 mm and the supported-resolution matrix remain required.

Work:
- Inspect the exact SANE backend and options included in `sane-wasm@0.5.0`.
- Compare scan settings and measured output with the Epson application.
- Locate row, page-length, protocol, allocation, and WASM memory limits.
- Check known and unknown line counts, bytes per line, end-of-file behavior, and partial final rows.
- Test the application allocation separately from the driver limit.
- Record the source version, build steps, license duties, and upstream route for any patch.

Acceptance:
- The report identifies the verified limiting layer, or supplies a bounded next experiment if it remains unknown.
- A required maximum receipt length and supported resolutions are recorded in millimeters and pixels.
- Memory estimates include scanner buffers, RGBA copies, canvases, and transfer encoding.
- RA-07 has a tested design or an explicit blocker. A larger JavaScript buffer alone is not proof of a driver fix.

## RA-04 — Prove Docker image hosting and browser isolation

Type: Research and deployment test. Size: M. Depends on: None.

Work:
- Record the confirmed i5-12500H, Unraid 7.2.0, 64 GB RAM, no GPU, and below-20% average CPU utilization; measure application throughput on x86 hardware.
- Define the amd64 image port, volume, environment, health-check, and external-URL contract. NAS/proxy/network/share configuration belongs to the user.
- Serve the application UI/API/assets from the image; use an isolated localhost server for the workstation development collector.
- Test image-supplied `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers.
- Check `crossOriginIsolated`, `SharedArrayBuffer`, WebUSB, workers, WASM, and asset response types.
- Identify all external modules, OCR language data, WASM, and worker assets. Prefer pinned assets served from the same origin.
- Test the planned Drive authorization flow with opener isolation enabled; provide user-facing diagnostics for proxy login/session handling.

Acceptance:
- The image has a repeatable runtime contract and serves its complete application without host-native processing dependencies.
- The scan driver loads and accesses the scanner without USB access on the NAS.
- A startup check explains missing HTTPS, headers, APIs, or permission.
- The report records unsupported browser cases and externally supplied HTTPS/proxy requirements without implementing NAS configuration.

## RA-05 — Compare OCR and receipt extraction options

Type: Research. Size: M. Depends on: RA-01; RA-04 for NAS performance measurements.

Work:
- Compare current Tesseract, a server OCR option, and a suitable local document model where hardware permits.
- Test an external image/document service only after the user approves data transfer, retention terms, and a cost limit.
- Test original, grayscale, and selected enhanced images with the same samples.
- Measure date/time accuracy, review rate, runtime, memory, and cost. Start with native Tesseract CPU and benchmark RapidOCR/ONNX Runtime as a challenger.
- Bundle `eng`, `fra`, `jpn`, `chi_tra`, `chi_sim`; measure each language and mixed-script cases. Route language profiles rather than running all five engines on every receipt, and benchmark warm-engine latency.
- Test multiple date candidates and dates unrelated to the purchase.
- Keep the engine interface independent of the selected provider.

Acceptance:
- A comparison report names exact versions, settings, hardware, and sample counts.
- A decision record selects the first engine and any bounded fallback.
- Model statements of confidence are not treated as measured accuracy.
- Missing or unsupported evidence leads to review, not a guessed purchase date.

## RA-06 — Implement explicit scan session control

Type: Feature. Size: M. Depends on: RA-02.

Work:
- Add explicit states for disconnected, connecting, ready, reading, stopping, and recovery needed.
- Serialize device operations and prevent concurrent scan loops.
- Add a tested stop/close path. Release the scanner on close or refresh without a required explicit disconnect action; keep disconnect as an optional control.
- Minimize device ownership and test recovery on the next connection. Do not depend on asynchronous unload work or promise release after every crash or forced close.
- Separate permission status from an open device handle.
- Prevent competing tabs from using the device. Recover stale tab ownership after a crash.
- Replace the 30-second cutoff with the verified session design. Retain bounded operation deadlines for actual faults.
- Report jams and disconnections rather than silently retrying forever.

Acceptance:
- The RA-02 matrix passes on supported clients; complete 20 close/refresh and reconnect cycles without explicit disconnect or a physical reset under normal conditions. Record browser and hardware limits.
- An idle session stays ready for 30 minutes, and a long active scan is not stopped by an idle timer.
- Stop, cancel, and reconnect leave no overlapping device operation.
- A lost browser permission or failed device reset produces a clear recovery instruction.

## RA-07 — Support long receipts without silent truncation

Type: Feature. Size: L. Depends on: RA-03, RA-06.

Work:
- Apply the verified backend option or patch. Pin and document any custom driver build.
- Replace fixed allocation assumptions where required with bounded chunk collection.
- Validate actual row counts, row boundaries, dimensions, and end-of-file status.
- Set explicit byte and pixel limits. Reject unsupported output with an actionable message.
- Avoid full-height canvas operations when they exceed tested browser limits.

Acceptance:
- Required long samples pass at every supported resolution, including samples that failed before.
- A visible end marker is present in the result; output is compared with the reference scan.
- Tests cover unknown line count, overflow, partial rows, cancellation, and memory limits.
- Incomplete scans are never reported as complete.

## RA-08 — Add durable original storage and receipt records

Type: Feature. Size: M. Depends on: RA-01, RA-04.

Progress: `server/api.py`, `storage.py` and `models.py` implement chunked/checksummed receive, complete-frame validation, fsynced originals and SQLite WAL receipt/group/job records. Uploads resume after container recreation. See the [runtime contract](../application-runtime.md) for the initial schema and format limits.

Work:
- Add a receipt API, file storage, schema migrations, and a small database.
- Store a lossless, unchanged original on disk with checksum, dimensions, resolution, scan settings, and capture time. Keep it until approval and durable approved artifact commit; apply RA-21 cleanup after that point.
- Keep capture time separate from purchase date. Give receipts stable IDs independent of filenames.
- Route uploads through Caddy/Authelia; do not add app accounts or login sessions. Check request origin, type, dimensions, byte limits, and available space.
- Use staged writes and safe finalization. Recover incomplete writes after restart.

Acceptance:
- The service acknowledges a save only after the original and receipt record are durable.
- Repeating a request with the same capture ID does not create another receipt.
- A conflicting payload for the same ID is rejected.
- Disk-full, malformed-image, interrupted-write, and unauthorized-request tests pass.
- Original content cannot be replaced by a later processing step. RA-21 controls deletion, not image processing.

## RA-09 — Add the browser transfer queue

Type: Feature. Size: M. Depends on: RA-06, RA-08. Integrate RA-07 before long-scan release.

Progress: the Preact UI retains captures in Dexie/IndexedDB before uploading and deletes transfer copies only after matching durable acknowledgments. Browser checks cover lost acknowledgments/reload, duplicate avoidance and compiled-driver long-frame transfer. Physical USB lifecycle and quota-exhaustion acceptance remain open.

Work:
- Save complete scans to browser storage before starting transfer where capacity permits.
- Track local save, upload, NAS acknowledgment, retry, and failure separately.
- Resume pending uploads after refresh with a stable capture ID and checksum.
- Request persistent storage where supported. Show storage limits and pending receipt count.
- Bound capture and transfer concurrency. Pause intake before storage is exhausted.
- Remove browser transfer copies after verified durable NAS acknowledgment. Track pending deletions for the next browser session; do not depend on unload. RA-21 defines active-file and browser deletion limits.

Acceptance:
- Refresh and network interruption do not lose a locally saved scan or create a duplicate.
- A lost server response followed by retry produces one NAS receipt.
- Quota failure stops intake with a warning and offers a local export when possible.
- The UI does not claim that an in-memory or partially captured scan is safe.

## RA-10 — Add durable background jobs

Type: Feature. Size: M. Depends on: RA-08.

Progress: the SQLite queue and separate worker implement immediate processing, renewable leases, three bounded attempts, manual retry, approval, post-commit cleanup and Drive jobs. Tests cover lease recovery, failed archive writes, filesystem-finalization replay and decode replay after approved cleanup. Tesseract currently runs per receipt; persistent warm engines and NAS throughput remain benchmark work.

Work:
- Add persisted jobs for image processing, extraction, export, and Drive transfer.
- Record stage, attempts, version, timestamps, and a safe error summary.
- Use bounded retries and worker leases that can recover after a crash.
- Make each stage safe to repeat. Keep failed jobs available for review or retry.
- Limit concurrency for the measured NAS memory capacity.
- Enqueue processing immediately after each durable receive commit. Reuse warm engines; do not wait for the full 30–40 receipt batch without a measured benefit. Measure single-receipt latency and queue-drain time separately.

Acceptance:
- Restart the service during each stage and recover without lost receipts or duplicate active jobs.
- Repeated failure stops automatic retries and exposes the next action.
- Retrying Drive transfer does not repeat OCR unnecessarily.
- Health checks distinguish API availability, worker health, queue delay, and storage capacity.

## RA-11 — Compare versioned OpenCV procedures

Type: Feature. Size: M. Depends on: RA-01, RA-05, RA-10.

Work:
- Run a bounded, versioned set of OpenCV procedures from the unchanged original. Record recipe, parameters, OpenCV version, and input/output checksums.
- Test orientation, deskew, cautious crop, background correction, local contrast, and thresholding. Bound procedure count, pixels, memory, and runtime.
- Compare every result with the original and check for lost text, clipped content, and damaged faint print. Prefer a readable binary image only when text is preserved; retain grayscale or color as needed.
- Rank results, select the best supported result for each page, and offer alternatives in staging. Selection is not approval.
- Detect blank, blurred, clipped, and incomplete scans where possible. Keep quality checks separate from OCR certainty.
- Save the original and all procedure outputs on disk until approval and durable artifact commit under RA-21. Log every run for RA-22, including failed runs, metrics, automatic rank, and runtime.

Acceptance:
- Faint-text samples remain readable in the chosen final image.
- Cropping does not remove labelled receipt content in the test set.
- Every result enters staging; blank and defective samples have clear warnings.
- Tests compare preserved text with labelled samples and the original, not OCR agreement alone.
- Each run has a versioned record and a saved output or failure. Reproduction uses retained inputs; deleted originals are not assumed to remain available.

## RA-12 — Extract receipt fields with source evidence

Type: Feature. Size: M. Depends on: RA-05, RA-10, RA-11.

Work:
- Extract the purchase date from the whole receipt without a user-selected box.
- Keep raw OCR, text locations where available, competing field candidates, and engine version.
- Extract transaction time with source evidence for RA-20 grouping and RA-16 naming. Optional merchant/layout signatures may assist OCR without requiring a merchant name. Currency, totals, items, and transaction references are deferred.
- Select the earliest supported complete transaction date/time per receipt, regardless of terminal/register source. Preserve every candidate and record the selection reason. Pair dates/times by source context; never form a new timestamp from independently minimized components. Resolve ambiguous parses/associations in staging.
- Require a resolved date and time for the final path. Missing values stay in staging for user resolution; do not substitute capture time.
- Validate dates and distinguish transaction, return, promotion, and print dates.
- Preserve ambiguity in day/month order and missing years. Use locale and expected period as evidence, not permission to invent a value.
- Treat receipt text as untrusted input to any model. It cannot authorize tools, change instructions, or choose external destinations.

Acceptance:
- Tests cover ambiguous numeric dates, named months, missing years, two-digit years, old receipts, multiple dates, and invalid dates.
- Tests include French months, Japanese/Chinese year-month-day notation, mixed scripts, and Japanese era dates where the real corpus requires them.
- Every proposed purchase date points to source evidence or is marked unsupported.
- Multiple genuine transaction timestamps select the earliest chronological candidate, including across midnight and with seconds present; their presence alone does not force ambiguity. Unresolved interpretations remain reviewable rather than being resolved by simply taking their minimum.
- Model output follows a validated schema; malformed output goes to review.
- The user can inspect why a date was proposed.

## RA-13 — Add clarity checks and ranking

Type: Feature. Size: M. Depends on: RA-01, RA-12, RA-14.

Work:
- Combine image quality, date/time validity, source evidence, candidate agreement, and measured extraction performance to classify clear and unclear results. Include RA-20 grouping evidence when available; show image, extraction, and grouping confidence separately.
- Sort unclear results first in staging. Show reasons and confidence only where test evidence supports it; otherwise show unknown confidence.
- Keep clarity, approval, and rescan states separate. Clear results still need user approval.
- Version the rules and tune them without using the reserved test set.

Acceptance:
- No clarity score or rank can approve a receipt or bypass staging.
- Unsupported or conflicting dates and times are marked unclear and block final naming until resolved.
- Reports show clarity errors and wrong-date counts separately, with sample counts and confidence limits.
- Rules can be disabled or rolled back without changing approvals, corrections, or retention policy.

## RA-14 — Build mandatory staging and approval

Type: Feature. Size: M. Depends on: RA-08, RA-10. Add RA-12 evidence when available.

Progress: manual date/time review, full-resolution strip inspection, same-minute grouping/vendor-hint veto, manual combine/split/reorder, path preparation and version-bound approval are implemented. Missing fields/completeness/readability block approval. Approved exports are immutable in this slice; revision, replacement-scan and pinning workflows remain.

Work:
- Stage all clear and unclear results before Drive; show unclear results first, reasons, and justified confidence. Show the original beside proposed fields and procedure alternatives before approval.
- Let the user edit fields, rotate pages, choose each page's processed master, or request a rescan.
- Start with manual field entry and manual grouping so the storage-to-Drive path can be tested before extraction and automatic grouping are ready.
- Let the user combine, split, and reorder groups and pages, and select items or groups to approve and upload. Show group membership and the final path before approval.
- Link a replacement scan to the same receipt, retain capture metadata, and invalidate stale output. RA-21 controls image retention.
- Bind approval to an exact version of membership, page order, selected masters, fields, and path. Changes invalidate approval and pending uploads for that version.
- Record corrections, author, time, source evidence, and version. Check the version at approval, artifact commit, and upload dispatch.
- Offer a bad-sample pin before approval to retain originals and all results for improvement under RA-21.

Acceptance:
- A field correction or rescan resolves the review without editing files by hand.
- Unresolved, unselected, or unapproved items cannot enter Drive upload. Clear items cannot bypass staging.
- Concurrent edits and stale approvals are rejected. Combine, split, reorder, rescan, and alternative selection tests invalidate prior approval.
- A late job cannot overwrite a correction or dispatch stale output. An upload already in progress uses its immutable approved version and is recorded for reconciliation.
- Selected groups and items can be approved and queued without approving the rest of the batch.

## RA-15 — Improve results from confirmed corrections

Type: Feature. Size: M. Depends on: RA-01, RA-12, RA-14.

Work:
- Store confirmed labels and optional date-region/layout rules; merchant names are not required. Pin needed bad-sample originals and all procedure results before approval; normal originals are not kept long term.
- Require user confirmation of a proposed rule. A new merchant does not automatically create a trusted rule.
- Match rules only when layout or optional merchant evidence supports their use. Benchmark visual embeddings only if simpler OCR-anchor/geometric matching is insufficient; no vector database is a release requirement.
- Compare changes against prior failures and the reserved test set before enabling them.
- Provide rule history, disable, and rollback controls. Keep training data private by default.

Acceptance:
- A repeated merchant case improves without damaging measured results for other merchants.
- A changed layout falls back to extraction or review instead of using an invalid crop.
- One correction cannot silently change all prior receipts.
- Reports distinguish a saved example, an enabled rule, and a trained model. No custom training is required.

## RA-16 — Create readable receipt PDFs

Type: Feature. Size: M. Depends on: RA-10, RA-14. Use RA-11 output when available.

Progress: lossless reference TIFF masters, DPI-sized image PDFs, immutable manifests and collision reservations are implemented. The amd64 container smoke check verifies an approximately 881 mm real sample's PDF page size and embedded RGB checksum, plus approved artifact recovery after recreation. Enhanced-master selection and viewer compatibility beyond structural checks remain.

Work:
- Build each group PDF from the selected per-page processed masters in the approved order. Use readable binary images where text is preserved; otherwise use grayscale or color.
- Durably commit the approved PDF, selected per-page masters, checksums, and metadata before RA-21 cleanup. Failed commits retain all staging files.
- Use scan resolution for physical page size and test very long pages in common viewers.
- Split presentation pages if required by viewer limits without losing source image content.
- Use `{year}/{month}-{month_name}/{year}{month}{date}-{hour}{minute}.pdf`, for example `2026/09-September/20260914-1721.pdf`. Use four-digit year, two-digit month/day/hour/minute, English month name, and 24-hour transaction time.
- Use the earliest supported complete transaction timestamp across all member receipts for naming, including original/return groups. Preserve every date/time and source region, compare full timestamps before minute formatting, and show the selected source/reason in staging.
- Keep missing date/time and uncertain naming sources in staging; manual resolution is required before approval/upload and no missing-time exception is allowed. Merge same-minute groups unless clearly different vendors. For non-mergeable groups reserve `-{n}` (`-1`, `-2`, etc.) transactionally, check existing files, and show the stable final path before approval. Keep IDs separate from paths.
- Store PDF checksum, group/source version, selected master versions, naming source, user decisions, and export version.
- Keep a manual download path independent of Drive availability.

Acceptance:
- PDFs preserve readable faint text and contain the complete approved image.
- Missing times block approval/final path commit/upload until resolved. Non-mergeable same-minute groups use durable suffix reservations; retries cannot overwrite or renumber another artifact.
- A source, grouping, order, or naming change needs new approval and creates a controlled new export version.
- Tests cover combined original/return naming, retained dates, month boundaries, missing values, and collisions.
- Tests check page orientation, dimensions, complete content, and target viewer behavior.

## RA-17 — Upload approved receipts to Google Drive

Type: Feature. Size: M. Depends on: RA-04, RA-10, RA-16.

Progress: optional server-held OAuth, existing-root validation, folder/name lookup, explicit approved-only delivery, resumable upload and identity reconciliation are implemented. Simulated-provider tests cover a lost successful response, filename conflicts, state replay and token file permissions. Live account/OAuth verification awaits configuration.

Work:
- Use the personal Drive account and existing receipts root shared with the user's wife. Preserve inherited sharing and use the approved RA-16 year/month path and collision suffix.
- Use the least Google permission scope that supports the selected folder workflow.
- Verify collision visibility for pre-existing files not created by the app; `drive.file` alone may need supplementary read-only metadata access. Persist folder/file IDs instead of relying on names alone.
- Keep refresh tokens and other credentials on the server. Support revocation and reconnection.
- Use stable receipt/export identity to reconcile retries, including a successful upload with a lost response.
- Handle resumable transfers, rate limits, expired credentials, and network failures.
- Upload only selected, version-approved, durably committed artifacts from staging. Recheck approval and path at dispatch; never regenerate from deleted originals.
- Define an explicit, user-approved replacement policy for corrected versions. Reconcile an in-flight older version; never treat a path collision as permission to overwrite.

Acceptance:
- Only user-selected and approved items or groups upload, with the approved path and sharing policy. No clear or unclear result bypasses staging.
- Repeated jobs and unknown upload outcomes produce one intended file per export policy.
- Authentication failure queues work without blocking scanning or losing approved artifacts. Drive failure does not require keeping normal originals after a durable approved commit.
- Store the Drive file ID, link, export version, and verification result.
- Neither credentials nor raw receipt text or images appear in routine logs. Restricted procedure records follow RA-22.

## RA-18 — Package and protect the NAS service

Type: Deployment. Size: M. Depends on: RA-04, RA-08, RA-10, RA-17.

Progress: a pinned-base amd64 Docker image builds and runs non-root with all five OCR packs, local scanner/UI assets, isolation headers, exact-origin checks, persistent mounts, child-process supervision and health checks. The [runtime instructions](../application-runtime.md) and isolated container smoke test cover recreation without host/proxy configuration. Broader operational acceptance remains open.

Work:
- Supply pinned build assets and a runnable amd64 Docker image with HTTP port, persistent volumes, health checks, environment variables, external URL/OAuth callback, and worker limits documented. Do not implement NAS, proxy, network, or share configuration.
- Include tested HTTPS, isolation headers, correct worker/WASM response types, and persistent volume settings.
- Honor the external authentication boundary and test expired-session/login-response handling, request-origin protection, and upload limits. No app-specific authentication implementation or Caddy/Authelia configuration.
- Run with minimum filesystem access. Do not expose the NAS USB devices to the service.
- Document `/state`, `/work`, `/samples`, and `/archive` mount semantics; require a SQLite-compatible local filesystem for state. User chooses host placement.
- Read `OPENROUTER_API_KEY` from the environment only when external LLM calls are needed; support starting with LLM features disabled. Do not request the key during sample collection.
- Document installation, upgrade, schema migration, compatible rollback, restart recovery, and log retention. App-managed backup and backup restore are excluded.
- Keep LAN access as the default. Remote access is a separate decision.

Acceptance:
- Start the image with fresh persistent directories using the documented runtime contract; no NAS-specific setup is required from the app.
- Recreate the container without losing receipt data or pending jobs.
- Verify checksums, records, and Drive references after container recreation against persistent volumes.
- A restart does not need new Drive authorization unless credentials were revoked or removed.
- No receipt or API endpoint is public by accident.

## RA-19 — Run release and failure tests

Type: Validation. Size: M. Depends on: RA-06 through RA-18, RA-20, RA-21, RA-22. RA-23 is optional and does not block release.

Work:
- Run the reserved receipt set on the target workstation and NAS.
- Test long scans, refresh at each capture stage, browser crash, second-tab access, jams, and cable removal.
- Test NAS outage, browser quota limits, full NAS disk, job crash, corrupt upload, Drive outage, and token expiry.
- Measure memory growth during a sustained batch and verify bounded job concurrency.
- Check that clear and unclear results enter staging, with unclear first, and that only selected, current approvals reach Drive.
- Test automatic grouping, manual combine/split/reorder, per-page alternatives, original/return naming, missing times, and path collisions.
- Test concurrent edits, stale jobs, stale approvals, and edits during upload. Compare final PDFs with originals before cleanup or use pinned test samples.
- Test cleanup after durable approved commit without Drive, failed commits, sample pins, browser deletion, and container restart/recreation.
- Verify all procedure run records, versions, ranks, selections, overrides, failures, and runtime. Keep optional LLM tests separate from release conditions.

Acceptance:
- Publish results against the epic release checks, including failures and sample counts.
- Before durable approved commit, failures preserve originals and all procedure outputs. After commit, failures preserve selected masters, PDFs, and metadata; pinned samples remain protected. Each failure has a clear recovery action.
- If USB recovery remains hardware-dependent, record the exact limit rather than claiming it is fixed.
- Any unmet release target has an explicit user-approved scope change or blocks release.

## RA-20 — Group related receipts automatically

Type: Feature. Size: M. Depends on: RA-12, RA-14.

Work:
- Combine same-calendar-date/same-minute receipts by default unless clear vendor evidence vetoes the merge. Unknown vendor evidence permits merging; differing seconds within the same minute do not veto it. Cross-minute tolerance is an optional later experiment.
- Use optional merchant/header/logo evidence for the vendor veto without requiring a normalized merchant name. Amount, currency, item, and reference extraction remain deferred.
- Do not use scan proximity or visual similarity alone as proof. Keep weak or conflicting matches unresolved in staging and show reasons.
- Retain each receipt's identity, dates/times, optional type, and evidence. Different-time returns require manual combine unless a compatible original transaction timestamp is actually printed. Support ordered pages without deleting duplicate-looking captures.
- Use each receipt's RA-12 earliest supported timestamp as its date/minute grouping key, and RA-16's earliest member timestamp for group naming. Unsupported or ambiguous sources require staging resolution.
- Integrate automatic groups with RA-14 manual combine, split, reorder, selection, and version-safe approval. Group changes invalidate prior approval.
- For a match to an uploaded original, propose a staged revision using retained selected page images. Require new approval before a Drive update; do not silently change the existing group.
- Check complete-group timestamp/vendor consistency so an unknown-vendor page cannot bridge two clearly different vendors. Non-mergeable groups use RA-16's stable numeric suffix rule.

Acceptance:
- Tests cover valid pairs, multiple returns, missing originals, unrelated similar receipts, duplicate scans, and conflicting evidence.
- All automatic groups enter staging; the user can correct membership and order before approval.
- Grouping errors cannot silently approve or upload any item. All original and return dates remain in committed metadata.

## RA-21 — Apply approval-based retention and cleanup

Type: Feature. Size: M. Depends on: RA-14, RA-16.

Progress: cleanup is a separate retryable job after durable masters/PDF/manifest and database approval. It rechecks archived checksums before deleting raw originals/chunks and working reference masters; previews/OCR/metadata remain. Failed approval preserves staging and Drive outages do not block cleanup. Production sample pinning and richer retention policies remain unimplemented; private collector samples are untouched.

Work:
- Keep unchanged originals and all procedure outputs on disk through staging. Approval alone does not permit deletion.
- Delete normal originals and unselected outputs only after the exact approved version's selected per-page masters, PDF, and metadata have a verified durable commit. Do not wait for Drive upload.
- Keep selected per-page processed masters, approved PDFs, and metadata long term. Keep source checksums and history, not false links to deleted originals.
- Retain all staging files on approval or commit failure. Make cleanup version-safe, restart-safe, and safe to repeat; protect files still used by pending work or other groups.
- Before approval, let the user pin a bad sample's original and all procedure results for improvement. Confirm the pin is durable before cleanup. Set a separate access, retention, and explicit deletion policy for pinned samples.
- Delete browser transfer copies after verified NAS save; record deferred deletion for the next session. Do not claim deletion from a closed browser or user-made copies.
- Retain deletion and pin state across container restarts. App-managed backups and backup restore are excluded; active-file cleanup does not control user-managed copies.

Acceptance:
- Tests cover failed commit, disk full, crash during cleanup, stale versions, shared files, durable pins, and repeat cleanup.
- Drive outage does not block eligible cleanup or remove the durable approved artifacts needed for retry.
- Active-file and browser policies state deletion timing, limits, and restart-recovery steps. Container restart does not revive deleted files as active receipts.

## RA-22 — Measure procedure performance over time

Type: Feature. Size: M. Depends on: RA-11, RA-14.

Work:
- Keep a restricted structured record for every procedure run: receipt/page/input version, procedure and OpenCV versions, parameters, output checksum, quality and text-preservation metrics, automatic score/rank, failure, and runtime.
- Record user selection, overrides, and reasons where supplied, linked to the run and approval version. Keep these records after image cleanup; mark unavailable images clearly.
- Compare results over time by procedure version and sample type. Report run counts, failures, runtime, rank changes, selections, and overrides.
- Keep automatic metrics, human preferences, and verified test labels separate. Neither rank nor user selection is proof of correct text.
- Use permitted pinned samples and reserved test labels for repeat comparisons. Do not put raw receipt text, images, or credentials in routine logs.

Acceptance:
- Successful, failed, cancelled, and timed-out runs have records; missing metrics have an explicit reason.
- Reports trace each choice to its procedure version and distinguish automatic ranking from human selection.
- Tests verify record retention after cleanup and comparison across versions without false accuracy claims.

## RA-23 — Test optional LLM-proposed OpenCV recipes

Type: Optional experiment. Size: M. Depends on: RA-11, RA-22, RA-05. Not a release condition.

Work:
- Let an optional LLM propose a structured recipe from a fixed allowlist of OpenCV operations and bounded parameters. Do not accept arbitrary code, synthetic images, or generated receipt text.
- Use GPT-6.1 Sol through OpenRouter for new procedure design; use GPT-6 Luna or Claude Haiku 5.5 for routine model tasks. Support an independently benchmarked Ollama provider with explicitly configured local model tags.
- Validate the recipe before execution. Run it in a sandbox with strict time, memory, pixel, file, and process limits; no network, secrets, arbitrary imports, or arbitrary code execution.
- Keep any model service outside the execution sandbox. Require explicit consent for external receipt data transfer, retention terms, and cost limits before an external call. Treat receipt content and model output as untrusted.
- Test candidates against originals, permitted pinned failures, and the reserved test set under RA-11 and RA-22. Require text-preservation checks and human review before promotion into the versioned procedure set.
- Record model/provider version, recipe version, tests, failures, runtime, and cost without exposing private content in routine logs. Support disable and rollback.

Acceptance:
- Invalid operations, out-of-range parameters, code payloads, network attempts, and resource-limit violations are rejected or stopped safely.
- No candidate changes receipt content or enters normal use without validated tests and explicit promotion.
- With the LLM disabled or unavailable, the mandatory workflow and release tests still pass.

## Separate future work

### RX-01 — Searchable receipt archive

Size: L. Depends on: RA-12, RA-16, RA-18.

Add full-receipt OCR, text locations, searchable PDF text, and a private search index. Compare text quality on the reserved samples. Link every search result to the receipt and source region. Do not assume that Google Drive will index every PDF immediately or completely.

Done when search returns verified receipt text linked to retained selected page masters and PDFs. Link to an original only while it is retained or pinned under RA-21; show when it has been deleted.

### RX-02 — Item and price database

Size: L. Depends on: RX-01 and a versioned receipt API.

Extract line items, quantity, units, discounts, tax, currency, and totals. Check arithmetic and retain source evidence. Keep raw merchant descriptions separate from confirmed product identities. Send uncertain matches to review.

Done when item corrections are traceable and price comparisons use compatible quantities, units, and currencies.

### RX-03 — Shopping search application

Size: L. Depends on: RX-02.

Build a separate mobile-friendly application against an authenticated, versioned API. Show purchase date, merchant, unit price, and receipt evidence. Decide remote access and stale/offline data policy before deployment.

Done when a user can compare verified prices away from home without exposing the receipt archive publicly.
