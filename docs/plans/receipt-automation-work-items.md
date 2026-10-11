# Receipt automation work items

Parent: [RA epic](receipt-automation-epic.md)
Design: [Design and decisions](receipt-automation-design.md)

All items are proposed and not started. All clear and unclear results must enter staging before Drive upload. Only user-approved, selected items or groups can be uploaded. RA-23 is optional and is not a release condition.

Size is a planning guide, not a delivery estimate:

- S: one focused change or report.
- M: several related changes with tests.
- L: split into smaller implementation tasks after the stated research.

## RA-01 — Build the receipt test set and baseline

Type: Research and tests. Size: M. Depends on: None.

Work:
- Collect permitted samples: clean, faded, damaged, skewed, blank, incomplete, and long receipts.
- Include new merchants, multiple dates, ambiguous numeric dates, missing years, missing times, filename collisions, and poor scans.
- Include itemized receipts with payment terminal receipts, original receipts with multiple returns, unrelated similar receipts, and groups with mixed page quality.
- Keep private receipt images out of public source control and routine logs.
- Label purchase and return dates, time where visible, expected groups and page order, visible text, image defects, and whether a person can read the receipt.
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

## RA-04 — Prove NAS hosting and browser isolation

Type: Research and deployment test. Size: M. Depends on: None.

Work:
- Record NAS hardware, storage, container support, and existing proxy constraints.
- Serve a minimal scan page through a trusted HTTPS hostname on the LAN.
- Test `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` through the actual proxy.
- Check `crossOriginIsolated`, `SharedArrayBuffer`, WebUSB, workers, WASM, and asset response types.
- Identify all external modules, OCR language data, WASM, and worker assets. Prefer pinned assets served from the same origin.
- Test login and the planned Drive authorization flow with opener isolation enabled.

Acceptance:
- A repeatable configuration works from a separate workstation, not only localhost.
- The scan driver loads and accesses the scanner without USB access on the NAS.
- A startup check explains missing HTTPS, headers, APIs, or permission.
- The report records unsupported browser cases and the required certificate setup.

## RA-05 — Compare OCR and receipt extraction options

Type: Research. Size: M. Depends on: RA-01; RA-04 for NAS performance measurements.

Work:
- Compare current Tesseract, a server OCR option, and a suitable local document model where hardware permits.
- Test an external image/document service only after the user approves data transfer, retention terms, and a cost limit.
- Test original, grayscale, and selected enhanced images with the same samples.
- Measure purchase-date accuracy, review rate, runtime, memory, and cost.
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

Work:
- Add a receipt API, file storage, schema migrations, and a small database.
- Store a lossless, unchanged original on disk with checksum, dimensions, resolution, scan settings, and capture time. Keep it until approval and durable approved artifact commit; apply RA-21 cleanup after that point.
- Keep capture time separate from purchase date. Give receipts stable IDs independent of filenames.
- Authenticate uploads. Check type, dimensions, byte limits, and available space.
- Use staged writes and safe finalization. Recover incomplete writes after restart.

Acceptance:
- The service acknowledges a save only after the original and receipt record are durable.
- Repeating a request with the same capture ID does not create another receipt.
- A conflicting payload for the same ID is rejected.
- Disk-full, malformed-image, interrupted-write, and unauthorized-request tests pass.
- Original content cannot be replaced by a later processing step. RA-21 controls deletion, not image processing.

## RA-09 — Add the browser transfer queue

Type: Feature. Size: M. Depends on: RA-06, RA-08. Integrate RA-07 before long-scan release.

Work:
- Save complete scans to browser storage before starting transfer where capacity permits.
- Track local save, upload, NAS acknowledgment, retry, and failure separately.
- Resume pending uploads after refresh with a stable capture ID and checksum.
- Request persistent storage where supported. Show storage limits and pending receipt count.
- Bound capture and transfer concurrency. Pause intake before storage is exhausted.
- Remove browser transfer copies after verified durable NAS acknowledgment. Track pending deletions for the next browser session; do not depend on unload. RA-21 defines backup and browser deletion limits.

Acceptance:
- Refresh and network interruption do not lose a locally saved scan or create a duplicate.
- A lost server response followed by retry produces one NAS receipt.
- Quota failure stops intake with a warning and offers a local export when possible.
- The UI does not claim that an in-memory or partially captured scan is safe.

## RA-10 — Add durable background jobs

Type: Feature. Size: M. Depends on: RA-08.

Work:
- Add persisted jobs for image processing, extraction, export, and Drive transfer.
- Record stage, attempts, version, timestamps, and a safe error summary.
- Use bounded retries and worker leases that can recover after a crash.
- Make each stage safe to repeat. Keep failed jobs available for review or retry.
- Limit concurrency for the measured NAS memory capacity.

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
- Extract transaction time, merchant, currency, total, receipt type, and transaction references where present. Keep evidence for RA-20 grouping and RA-16 naming.
- Require a resolved date and time for the final path. Missing values stay in staging for user resolution; do not substitute capture time.
- Validate dates and distinguish transaction, return, promotion, and print dates.
- Preserve ambiguity in day/month order and missing years. Use locale and expected period as evidence, not permission to invent a value.
- Treat receipt text as untrusted input to any model. It cannot authorize tools, change instructions, or choose external destinations.

Acceptance:
- Tests cover ambiguous numeric dates, named months, missing years, two-digit years, old receipts, multiple dates, and invalid dates.
- Every proposed purchase date points to source evidence or is marked unsupported.
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
- Store confirmed labels and optional merchant-specific date or layout rules. Pin needed bad-sample originals and all procedure results before approval; normal originals are not kept long term.
- Require user confirmation of a proposed rule. A new merchant does not automatically create a trusted rule.
- Match rules only when merchant and layout evidence support their use.
- Compare changes against prior failures and the reserved test set before enabling them.
- Provide rule history, disable, and rollback controls. Keep training data private by default.

Acceptance:
- A repeated merchant case improves without damaging measured results for other merchants.
- A changed layout falls back to extraction or review instead of using an invalid crop.
- One correction cannot silently change all prior receipts.
- Reports distinguish a saved example, an enabled rule, and a trained model. No custom training is required.

## RA-16 — Create readable receipt PDFs

Type: Feature. Size: M. Depends on: RA-10, RA-14. Use RA-11 output when available.

Work:
- Build each group PDF from the selected per-page processed masters in the approved order. Use readable binary images where text is preserved; otherwise use grayscale or color.
- Durably commit the approved PDF, selected per-page masters, checksums, and metadata before RA-21 cleanup. Failed commits retain all staging files.
- Use scan resolution for physical page size and test very long pages in common viewers.
- Split presentation pages if required by viewer limits without losing source image content.
- Use `{year}/{month}-{month_name}/{year}{month}{date}-{hour}{minute}.pdf`, for example `2026/09-September/20260914-1721.pdf`. Use four-digit year, two-digit month/day/hour/minute, English month name, and 24-hour transaction time.
- Proposed naming source for combined original/return groups: use the original purchase date and time by default. Keep all purchase and return dates, times, and source evidence in metadata; show the chosen source for confirmation.
- Keep missing date/time, uncertain naming sources, and path collisions in staging for user resolution. Do not invent values, silently add suffixes, or overwrite another artifact. Keep internal stable IDs separate from paths.
- Store PDF checksum, group/source version, selected master versions, naming source, user decisions, and export version.
- Keep a manual download path independent of Drive availability.

Acceptance:
- PDFs preserve readable faint text and contain the complete approved image.
- Missing times and same-minute collisions block final path commit and upload until the user resolves them. No artifact is overwritten.
- A source, grouping, order, or naming change needs new approval and creates a controlled new export version.
- Tests cover combined original/return naming, retained dates, month boundaries, missing values, and collisions.
- Tests check page orientation, dimensions, complete content, and target viewer behavior.

## RA-17 — Upload approved receipts to Google Drive

Type: Feature. Size: M. Depends on: RA-04, RA-10, RA-16.

Work:
- Configure the account, target root folder, and existing sharing rules. Use the approved RA-16 year/month folder path and filename.
- Use the least Google permission scope that supports the selected folder workflow.
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

Work:
- Supply pinned build assets and a container deployment if the NAS supports it.
- Include tested HTTPS, isolation headers, correct worker/WASM response types, and persistent volume settings.
- Add authentication, session expiry, request-origin/CSRF protection where applicable, and upload limits.
- Run with minimum filesystem access. Do not expose the NAS USB devices to the service.
- Back up approved PDFs, selected per-page masters, metadata, database, corrections, settings, and encrypted credentials. Apply RA-21 policy to staging files, pinned samples, backup expiry, and restored deletion records.
- Document installation, upgrade, schema migration, rollback, restore, and log retention.
- Keep LAN access as the default. Remote access is a separate decision.

Acceptance:
- Install on an empty NAS service directory using the instructions.
- Recreate the container without losing receipt data or pending jobs.
- Restore a backup and verify checksums, records, and Drive references before workers resume.
- A restart does not need new Drive authorization unless credentials were revoked or omitted from restore.
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
- Test cleanup after durable approved commit without Drive, failed commits, sample pins, backup expiry, browser deletion, and restore.
- Verify all procedure run records, versions, ranks, selections, overrides, failures, and runtime. Keep optional LLM tests separate from release conditions.

Acceptance:
- Publish results against the epic release checks, including failures and sample counts.
- Before durable approved commit, failures preserve originals and all procedure outputs. After commit, failures preserve selected masters, PDFs, and metadata; pinned samples remain protected. Each failure has a clear recovery action.
- If USB recovery remains hardware-dependent, record the exact limit rather than claiming it is fixed.
- Any unmet release target has an explicit user-approved scope change or blocks release.

## RA-20 — Group related receipts automatically

Type: Feature. Size: M. Depends on: RA-12, RA-14.

Work:
- Automatically group itemized and payment terminal receipts, and original purchase and return receipts, using extracted dates, merchant, amounts, transaction references, and source evidence.
- Do not use scan proximity or visual similarity alone as proof. Keep weak or conflicting matches unresolved in staging and show reasons.
- Retain each receipt's identity, type, dates, and evidence. Support multiple returns and ordered pages without deleting duplicate-looking captures.
- Use the proposed RA-16 original purchase naming default for original/return groups. Require user confirmation or resolution of an unsupported source.
- Integrate automatic groups with RA-14 manual combine, split, reorder, selection, and version-safe approval. Group changes invalidate prior approval.
- For a match to an uploaded original, propose a staged revision using retained selected page images. Require new approval before a Drive update; do not silently change the existing group.
- Check complete-group consistency so a chain of weak pair matches cannot join unrelated purchases.

Acceptance:
- Tests cover valid pairs, multiple returns, missing originals, unrelated similar receipts, duplicate scans, and conflicting evidence.
- All automatic groups enter staging; the user can correct membership and order before approval.
- Grouping errors cannot silently approve or upload any item. All original and return dates remain in committed metadata.

## RA-21 — Apply approval-based retention and cleanup

Type: Feature. Size: M. Depends on: RA-14, RA-16.

Work:
- Keep unchanged originals and all procedure outputs on disk through staging. Approval alone does not permit deletion.
- Delete normal originals and unselected outputs only after the exact approved version's selected per-page masters, PDF, and metadata have a verified durable commit. Do not wait for Drive upload.
- Keep selected per-page processed masters, approved PDFs, and metadata long term. Keep source checksums and history, not false links to deleted originals.
- Retain all staging files on approval or commit failure. Make cleanup version-safe, restart-safe, and safe to repeat; protect files still used by pending work or other groups.
- Before approval, let the user pin a bad sample's original and all procedure results for improvement. Confirm the pin is durable before cleanup. Set a separate access, retention, and explicit deletion policy for pinned samples.
- Delete browser transfer copies after verified NAS save; record deferred deletion for the next session. Do not claim deletion from a closed browser or user-made copies.
- Define staging recovery backups and a finite backup expiry period. Carry deletion records into restore and reapply them before workers start. Explain that live cleanup cannot immediately erase immutable backups; exclude expired staging data from new backups.

Acceptance:
- Tests cover failed commit, disk full, crash during cleanup, stale versions, shared files, durable pins, and repeat cleanup.
- Drive outage does not block eligible cleanup or remove the durable approved artifacts needed for retry.
- Backup and browser policies state deletion timing, limits, and recovery steps. Restore does not revive expired files as active receipts.

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
