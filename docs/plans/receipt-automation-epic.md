# Epic: Scan, check, and file receipts automatically

Status: Proposed
Date: 2026-10-11
Epic ID: RA

## Goal

After the user opens the scan page and gives USB permission, the user puts receipts into the Epson RR-70W. The system scans them, compares image procedures, extracts fields, combines related receipts, and puts all results in a staging area.

The user checks the staged results, selects items, and approves them for Google Drive upload. Unclear results appear first. The user can correct fields, combine or split groups, select another image result, save a bad result as a test sample, or scan again. No result uploads without user approval.

The scanner driver must stay in the browser. The scanner stays connected to the computer at the scan location, not to the NAS.

## Documents

- [Work items](receipt-automation-work-items.md): scope, dependencies, and acceptance checks.
- [Design and decisions](receipt-automation-design.md): service boundaries, data, recovery, and open questions.
- [Concrete architecture](receipt-automation-architecture.md): proposed stack, Docker image contract, workstation sample collector, model routing, and confirmed constraints.

These files are the planning record. A [first application slice](../application-runtime.md) and pinned Epson backend patches are implemented; broader release acceptance remains open.

A workstation [sample-input utility](../../sample-input.html) captures raw scanner bytes through WebUSB, records defaults/diagnostics, saves private ZIPs, and labels date/time/languages/groups. Run it without Docker using the [sample instructions](../sample-capture.md). The reviewed corpus contains 53 captures. The amd64 application image passes isolated durable-transfer/approval/PDF checks; physical USB lifecycle and near-1,000 mm verification remain pending.

## Current state

The following facts come from the project files:

| Area | Current implementation | Planning effect |
| --- | --- | --- |
| Scanner | `../../scanner.mjs` loads `sane-wasm@0.5.0` and uses WebUSB permission. | Keep device access in the browser. |
| Scan length | `scanner.mjs` allocates `bytes_per_line * lines` before reading. | Check both the driver limit and the application buffer. Support unknown length safely if the driver can supply it. |
| Device release | `scanner.mjs` calls close on `beforeunload`. Its scan loop cancels between attempts. | Do not depend on unload for normal release or recovery. |
| Timeout | `../../app.mjs` aborts after 30 seconds. It resets the timer after each complete image. | A long scan can also reach this timer. Replace it only after cancellation and recovery tests pass. |
| Image processing | `../../imgproc.mjs` trims the image, applies adaptive mean thresholding, and fills corners. | Revise OpenCV procedures for readable binary output. Keep the original and all procedure results until approval. |
| OCR | `../../ocr.mjs` uses Tesseract.js 5, English text, and date patterns. The application lets the user select a date area. | Add full-receipt extraction, evidence, and review. Do not rely only on more date patterns. |
| PDF | `../../pdf.mjs` writes 1-bit image PDFs without a text layer. | Add readable grayscale or color output. A search text layer is a later extension. |
| Hosting | The legacy page uses a local static server/CDNs. The development collector uses `sample-server.py` and local pinned scanner assets. | Deliver the final Docker image with isolation headers and controlled assets; the user handles NAS/proxy configuration. |
| Storage | The application holds pages in memory and supports local file output. | Add durable receipt storage and retryable uploads. |

The user reports that Epson software scans receipts beyond the current length limit. This is useful evidence of a software restriction. The exact backend, limit, and required source change are not yet verified.

## Scope

### Required for the first complete release

1. Reliable browser scan sessions without the current idle cutoff.
2. A verified long-receipt path, with explicit limits and no silent truncation.
3. A lossless original image stored before OCR or image changes.
4. Durable transfer to the NAS, with visible save status and safe retries.
5. Automatic image preparation that preserves faint text.
6. Automatic transaction date/time extraction with evidence and ambiguity checks.
7. A staging area for every result, with unclear results first, confidence indicators, corrections, and rescans.
8. Automatic PDF creation and Google Drive upload after approval.
9. A runnable amd64 Docker image with documented ports, volumes, environment settings, and restart/job recovery. The user configures Unraid/Caddy/Authelia.
10. Measured improvement from confirmed corrections and per-procedure run history.
11. Automatic grouping of itemized and payment receipts, or original and return receipts, with manual combine and split controls.
12. Selected approval and upload; no automatic approval based only on confidence.
13. Original and candidate-image cleanup after approval, with explicit sample retention for bad results.

### Not required for the first release

- Full-text search quality beyond the OCR needed to find receipt fields.
- Item-by-item prices, product matching, and price history.
- A shopping application or remote mobile search.
- Custom model training.
- App-managed backups and backup restore.
- Application-specific accounts or authentication; the deployment uses Caddy and Authelia.
- NAS storage/proxy/network configuration or installation automation.
- Required merchant, amount, currency, item, or transaction-reference extraction.
- An open internet service or access without authentication.
- Scanning while the browser is closed or the computer is asleep.

## User workflow

1. Open the HTTPS scan page on the computer connected to the scanner.
2. Connect the scanner if the browser requests permission. Start a scan session if required.
3. Put receipts through the scanner. The system processes scans and combines related documents into proposed groups.
4. Open staging. See unclear results before clear results, with confidence levels and reasons.
5. Check group contents and image results. Combine missed matches, split wrong matches, reorder pages, correct fields, or scan again.
6. Save any bad result as a sample before approval if it will help improve procedures.
7. Select staged items and approve them for PDF creation and upload. Clear results still need approval.
8. Close or refresh the tab without a required disconnect action. Scanner release and reconnect must pass browser tests. An explicit disconnect control can remain for recovery.

A one-time connection or session action is acceptable. Browser permission, tab suspension, and USB behavior can prevent a fully unattended start. Test these limits; do not promise to bypass them.

## Main design choices

- Keep only device control, scan capture, a local transfer queue, and the user interface in the browser.
- Put durable storage, image preparation, OCR, field checks, PDF creation, and Drive transfer on the NAS when tests show a useful benefit.
- Use one HTTPS origin for the application and its API. Supply isolation headers in the deployment, not through user instructions alone.
- Keep the original scan unchanged and every procedure result on NAS disk until approval. Keep selected processed page images, approved PDFs, and metadata long term.
- Delete temporary originals and unselected results only after the approved files and approval record are durable. A failed approval retains them. Explicitly saved samples are exempt.
- Keep NAS storage as the source record for approved artifacts and metadata. Upload approved PDFs to Google Drive. App-managed backup and restore are outside this epic.
- Start with one service, a durable job queue, file storage, and a small database. Do not add several services without a measured need.
- Benchmark local OCR first. Test an external image or document model only with explicit approval for data transfer and cost.
- Use corrections as verified examples and optional merchant rules. Do not silently retrain a model or make broad rules from one receipt.
- Require transaction date and time only. Merge same-date/same-minute receipts unless clear vendor evidence vetoes the merge; optional merchant/layout information supports OCR and that veto. Amounts/references remain deferred.
- When there are multiple transaction timestamps, choose the earliest supported complete date/time per receipt for extraction/grouping, and across member receipts for group naming. Retain all timestamps and source evidence; cash-register and payment-terminal sources have no priority over chronological order.
- Use a CPU-based Python service on the i5-12500H/Unraid 7.2.0 environment, with browser-only USB capture, SQLite jobs, and files. Target approximately 1,000 mm at measured default DPI, subject to full-resolution readability checks.
- Process each scan as soon as its durable receive commit completes; reuse warm engines and bounded workers without waiting for the 30–40 receipt session to finish.
- Support English, French, Japanese, traditional Chinese, and simplified Chinese; include the archive scanned since 2021.
- Missing time blocks approval/upload until resolved in staging. If same-minute groups cannot merge, reserve a stable `-{n}` filename suffix.
- Run a bounded set of versioned OpenCV procedures, rank results, and let the user choose another result before approval. Prefer readable binary output; never hide lost text to meet that preference.
- Keep a history of every procedure attempt, score, selection, override, failure, and runtime. Summaries must show sample counts.
- Optionally ask an LLM to propose a constrained image-processing procedure when existing results are poor. Test it before reuse. Do not generate replacement receipt text or pixels with a model.
- Route new procedure design to GPT-6.1 Sol and routine model tasks to GPT-6 Luna or Claude Haiku 5.5 through OpenRouter; support an independently benchmarked Ollama alternative.
- Request `OPENROUTER_API_KEY` only when external integration/testing is ready; supply it by environment variable.

## Delivery order

| Stage | Work items | Exit condition |
| --- | --- | --- |
| 0. Measure and choose | RA-01, RA-02, RA-03, RA-04, RA-05 | Test set, device findings, NAS limits, OCR comparison, and decision records exist. |
| 1. Protect capture | RA-06, RA-07, RA-08, RA-09, RA-10 | Long scans are checked. Refresh does not lose a saved scan. NAS receives originals safely. |
| 2. Prove the complete path | RA-14, RA-16, RA-17, RA-21 | A scan can be staged, selected, approved, and uploaded once. Cleanup preserves approved files and saved samples. |
| 3. Reduce review work | RA-11, RA-12, RA-13, RA-15, RA-20, RA-22 | Procedures are compared, related receipts are grouped, and staging shows reasons and performance history. |
| 4. Package the final app | RA-18, RA-19 | Docker image runtime contract, restart recovery, fault tests, and release checks pass. User handles deployment. |
| Optional improvement | RA-23 | A constrained LLM procedure can be tested when stored procedures are insufficient. |

Within a stage, run independent items in parallel. The work-item dependencies take precedence over this summary. In particular, the review page can start with manual fields before automatic extraction exists.

## Proposed release checks

Agree on the final numbers in RA-01. These are targets, not measured results.

- No silent data loss, scan truncation, overwritten originals, or duplicate Drive files in the fault tests.
- Complete 20 refresh/reconnect cycles on the supported browser without a physical USB reset under normal conditions.
- Keep a scan session ready for at least 30 minutes of idle time. Do not apply an idle timer to an active scan.
- Capture the agreed long-receipt samples at each supported resolution without missing rows.
- Prepare at least 90% of readable receipts in the reserved test set without a field correction. Selection and approval remain required.
- Find no wrong purchase dates among results marked clear in that test set. Publish the sample count; a small set is not proof of a production error rate.
- All results enter staging, sorted unclear to clear. Confidence levels have an explanation; untested scores are not shown as probability percentages.
- Grouping tests include true pairs and unrelated lookalikes. Manual combine and split preserve every page and invalidate stale approval.
- Closing or refreshing the scan tab needs no explicit disconnect under tested normal conditions.
- Each procedure result remains available on disk until approval. Sample pins survive cleanup. Every procedure run remains in performance history.
- Only selected, version-checked approvals enter the upload queue.
- Report unreadable, incomplete, or ambiguous receipts as needing review. Do not fill missing fields with invented values.
- Measure median and 95th-percentile capture-to-NAS and processing times on the actual NAS. Choose limits after the hardware test.
- Recover saved jobs after a browser refresh, NAS restart, network interruption, and expired Drive credentials.
- Recreate the container using its persistent volumes and verify pending originals, saved samples, selected images, corrections, pending jobs, and Drive references.

## Main risks

| Risk | Response |
| --- | --- |
| The driver limit needs a maintained fork. | Identify the source and build path first. Keep changes small, pin the build, and seek an upstream change. |
| A pending USB operation survives application cancellation. | Test actual cancellation and device release. A rejected promise does not prove the device operation stopped. |
| Long images exceed WASM memory or canvas limits. | Set tested limits and use bounded chunks or tiles. Never promise unlimited receipt length. |
| Weak print loses detail during thresholding. | Keep grayscale or color as a valid final image. Compare processing against the original. |
| OCR returns a plausible but wrong date. | Keep competing dates and source evidence. Use measured clarity rules and mandatory staging. |
| Timestamp grouping joins unrelated same-minute purchases. | Show matching dates/times and ambiguity, check whole-group consistency, and allow split before upload. |
| Approval removes an image needed for later procedure tests. | Offer a sample pin before approval. Explain that unpinned originals and alternatives will be deleted. |
| A NAS has too little memory for a chosen model. | Measure first. Use a smaller local engine or an approved external service. |
| Browser storage is full or cleared. | Request persistent storage where supported, show pending transfers, and stop capture before data is lost. |
| Receipt data leaves the private network. | Disclose Drive and optional OCR destinations. Limit access and keep secrets on the server. |

## Decisions needed before implementation

These questions do not block this plan. Resolve them in the named work items.

- i5-12500H, Unraid 7.2.0, 64 GB RAM, no GPU, and average CPU usage below 20% are confirmed. Deliver an amd64 Docker image; user owns NAS/proxy configuration. Measure actual processing throughput: RA-04 and RA-05.
- Initial workstation is an M1 Pro MacBook Pro with 32 GB RAM. Propose desktop Chrome/Edge for WebUSB; verify supported browser/OS behavior: RA-01 and RA-02.
- Approximately 1,000 mm is required. Use scanner-default DPI if readability passes; record the default and prove the backend path: RA-03.
- Date/time-only fields and English/French/Japanese/traditional/simplified Chinese are confirmed. Scanning began in 2021; collect actual date conventions and historical samples: RA-01 and RA-05.
- Whether external OCR is allowed, and its cost limit and retention terms: RA-05.
- Personal Drive and existing receipts folder shared with the user's wife are confirmed. Obtain root folder ID/OAuth setup when integrating: RA-17.
- Earliest complete transaction timestamp is the confirmed selection/naming rule. Missing time is prohibited at approval/upload. Same-minute receipts merge except clear vendor conflicts; non-mergeable collisions get numeric suffixes: RA-12, RA-16, and RA-20.
- App-managed backups and NAS configuration are excluded. Confirm sample retention: RA-21.
- External LLM permission, resource limits, and promotion checks for proposed procedures: RA-23.

## Required Google Drive path

`{year}/{month}-{month_name}/{year}{month}{date}-{hour}{minute}.pdf`

Example: `2026/09-September/20260914-1721.pdf`.

Use four-digit year, two-digit month and day, 24-hour time with two-digit hour and minute, and the full English month name. Here, `{date}` means day of month.

Confirmed rule: use the earliest supported complete transaction timestamp across the group's receipts, including itemized/payment and original/return groups. Keep all other timestamps as separate metadata. Compare full date/time before formatting to minute precision; show the selected source and reason in staging and allow correction.

Missing time or an unresolved group date requires resolution in staging before approval/upload; do not invent `0000` or allow a missing-time exception. Combine same-date/same-minute receipts unless clearly different vendors. If groups cannot merge, keep the first available base name and allocate `-{n}` (positive integers starting at 1), for example `20260914-1721-1.pdf`. Persist the reserved path for retries and never overwrite an unrelated or pre-existing file.
