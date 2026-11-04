# Workstation raw sample collector

This development tool captures receipts directly from the USB-connected Epson scanner using WebUSB and sane-wasm. It runs locally without Docker or a NAS connection. First-party Epson exports are not used as the raw source.

## Start

Requirements: Node/npm, Python 3.9+, and desktop Chrome or Edge. From the repository directory:

```sh
npm ci
python3 sample-server.py
```

Open **http://localhost:8000/sample-input.html**. The local server supplies the isolation headers, JavaScript, WASM, and workers needed by the driver. A plain `python3 -m http.server` does not supply those headers.

To choose another workstation storage directory or port:

```sh
python3 sample-server.py --samples "/path/to/receipt-samples" --port 8001
```

The default directory is `.receipt-samples/`, excluded from Git. The server binds to loopback only. It selects the generated patched bundle in `scanner-driver/build` when present, otherwise the npm sane-wasm 0.5.0 build. Startup output prints the selected path. A custom or unmodified build can be selected with `--driver-dir "/path/to/build"`.

## Capture and label

1. Close other applications using the scanner. Click **Connect scanner** and grant USB permission.
2. Leave **Save each capture to this workstation's sample folder** checked.
3. Click **Start capture session** and feed receipts. Each received scan is retained automatically with unlabelled date/time fields.
4. Click **Stop capture**, then select a saved sample and **Load selected**.
5. Enter the expected date/time, languages, condition tags, and grouping labels. Missing/ambiguous source times are valid test labels; the final application will require manual time resolution before approval/upload.
6. Use **Show strip / Next strip / Receipt bottom** to inspect 512-row raw regions at full resolution, check faint text and the physical receipt's bottom, and record that check. EOF and complete row counts establish transport completeness, not physical completeness.
7. Click **Save to workstation folder** to persist label changes. ZIP download is also available.

If a receipt has several transaction timestamps (for example, register and payment-terminal times), label the **earliest complete date/time** as the expected result. Record the other timestamps in Notes. Compare dates together with times, including seconds if printed: a timestamp just before midnight is earlier than one just after midnight on the following date. If the date/time association or interpretation is unclear, use an ambiguous label rather than guessing.

The collector preserves defaults unless the user explicitly selects Long receipt or another DPI. It records options before configuration, applied changes/read-back values, and settings used for capture. It does not crop, deskew, threshold, sharpen, OCR, or resample the stored original. "Raw" means bytes returned by the scanner/SANE before application processing; scanner firmware/backend-internal processing is not bypassed. Evaluate actual default-DPI readability on the samples before choosing production settings.

## Long-receipt jam retry

Epson documents a jam message above **508 mm** when long-paper mode is not selected. The collector now supports a patched backend profile: restart the server, refresh/reconnect, check **Long receipt**, set maximum length to **1,200 mm**, and choose **200 DPI** for the first retry. The status must show that the long-paper option is available. If the scanner does not advertise the necessary larger range, the profile is rejected before capture. See [driver findings, build and rollback](../scanner-driver/README.md).

A physical feeder jam is still possible. Record whether the paper physically stops and approximately how far it feeds. Export the failed sample ZIP if a retry fails; even an attempt returning no pixels is saved as diagnostic-only, with the failing phase/operation/status and settings. Do not mark that attempt physically complete.

## Bundle contents

- `original.bin`: unchanged scan bytes, including row padding, at full captured resolution; empty for explicitly marked diagnostic-only failures.
- `manifest.json`: SHA-256, frame format/depth, bytes per row, width/row count, scan options and DPI, USB/backend identity, read/EOF/error diagnostics, and expected labels.
- `preview.png`: optional, downsampled display image. This is not the original or a readability reference at full resolution.

## Diagnostic entries and deletion

`scanner-diagnostic` records are failed attempts that returned no image pixels; older versions also recorded some ordinary stopped attempts. They retain the settings, applied profile, failing phase/status, and timing so scanner problems can be investigated; `original.bin` is empty. Each attempt has its own ID, so an earlier failure remains listed separately from a successful retry.

With driver revision `receipt-longpaper-2`, ordinary empty-feeder/busy polling creates no sample. A normal user Stop before receiving any pixels also creates no diagnostic; Stop after partial pixels retains those pixels as an incomplete sample. Genuine jams, driver faults, and cleanup failures remain diagnostic evidence.

Saving a later failure no longer replaces an already displayed image or its labels. The failed attempt remains selectable in the saved list, and **Latest session failure** shows its separate ID/settings/error. The receipt's own diagnostics remain attached to the receipt being viewed. Existing successful ZIPs and older diagnostic entries remain intact.

After stopping capture, select an entry under **Saved in this browser** and click **Delete selected sample**. To clear the listed zero-image diagnostic records together, click **Delete listed diagnostics**; real image samples are preserved by that bulk action. Deletion removes both the browser entry and the matching `sample-{id}.zip` in this server's configured workstation folder (`.receipt-samples/` by default). Independently downloaded ZIPs are unaffected.

Restart `sample-server.py` and refresh the page after updating to get the deletion endpoint/buttons. If workstation deletion fails, the browser entry remains for retry. A missing workstation ZIP is treated as an already completed deletion. Deleting a loaded sample also clears its preview and in-memory copy so it cannot be accidentally saved again.

Frames use SANE enum values (`0` grayscale, `1` interleaved RGB; `2/3/4` separate color planes). The original bytes and manifest must remain together. Eight-bit data is stored byte-for-byte; 16-bit SANE samples from this WASM build are little-endian. Unsupported multi-frame output is retained as an incomplete sample rather than misreported as a complete RGB image.

Each capture is limited to 256 MiB/160 MP, with bounded chunk collection supporting an unknown row count. A malformed partial row, height mismatch, read error, limit, or user cancellation retains received bytes and marks the capture incomplete. Driver failures during start/parameter acquisition are retained even with no image bytes. The patched long-paper path is an experiment using advertised capabilities; a 1,000 mm physical scan still needs verification.

Stop is cooperative: an outstanding driver call must return before cancel/close can run. If a call stalls, the UI reports waiting rather than issuing overlapping device operations. Use Disconnect after the session; physical release after refresh/crash still requires hardware testing. Browser locks prevent two collector tabs at the same origin from driving the scanner concurrently.

The original is saved before preview generation. Browser quota or workstation save failures stop intake and retain the current sample for retry/export. Do not refresh while the current sample is only in memory. Workstation ZIP writes are checksum-verified and durably finalized; retries and label updates cannot replace the original with different bytes under the same sample ID.

Known development observation: the pinned driver's built-in synthetic SANE test backend stalled at its first read in a browser experiment. Driver/WASM initialization and test-device discovery/open/close passed. Stream capture is checked with simulated backends; physical Epson capture and release still need the real workstation test.

## Development checks

```sh
npm run test:samples
```

Stream tests cover unknown height, mutable WASM buffers, data with EOF, partial rows, height mismatch, multi-frame output, limits, cooperative cancellation, idle feeder, jams, and failed cancellation. Local-server tests cover persistent retries/label updates, immutable originals, checksum/origin validation, and isolation headers. Real USB behavior and long receipt capture must be checked on the workstation.

`npm run test:scanner-browser` exercises the actual compiled patched C/WASM backend against a simulated Epson USB transport, including the normal-length jam, long geometry/page-end sizing, missing-row rejection, and UI diagnostic export. Install the test browser with `npx playwright install chromium` first. It does not request access to a real scanner.
