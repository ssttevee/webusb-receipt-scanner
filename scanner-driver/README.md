# Browser Epson long-paper driver

This is a targeted experimental patch for the `epsonds` backend in sane-wasm 0.5.0. The collector uses the generated `build/` bundle when present. Its runtime remains a browser plus the workstation Python server; Docker is used only to compile the driver.

## Findings

- [Epson's RR-70W FAQ](https://epson.com/faq/SPT_B11B253205~faq-0000786-shared) says receipts over 20 inches (508 mm) can report a jam unless Auto Detect (Long Paper) is selected. Long paper requires 300 DPI or below, and some lengths require 200 DPI or below.
- The pinned backend parses ordinary `ADF AREA`, but only logs/discards `ADF AMAX`. Its normal acquisition rectangle consequently cannot use the separately advertised long-document height.
- This backend acquires a complete image inside `sane_get_parameters()`. A jam there can leave no image bytes for the browser, even after paper has moved through the scanner.
- The original backend pads short images to the requested height. That is unsuitable for verifying physical long-receipt completeness.

These findings explain a plausible length-related jam path. A physical jam remains possible; the error text alone cannot distinguish the two.

## Patch

`epsonds-longpaper.patch` adds an opt-in `long-paper` option:

- Use the scanner's advertised `AMAX` height rather than inventing an unsupported device limit. Ordinary scan geometry remains the baseline when the option is off.
- Limit this experiment to ADF Front at 300 DPI or below. The collector further bounds requested length to 1,200 mm and checks the actual advertised maximum.
- Send `PEDT` only if the scanner advertises paper-end detection. Disable device crop/deskew in the long profile and preserve acquisition width.
- Use the device's actual page-end height, without padding out a long receipt to the requested maximum. Reject raw byte-count/page-end mismatches rather than synthesizing missing rows.
- Keep source statuses as errors. Do not reinterpret a jam as EOF or successful capture.

The generated bundle includes both `epsonds` and `test`, libraries' licensing texts, the patch, and `provenance.json` with source revisions and artifact checksums. The complete physical length/resolution/readability test matrix remains pending.

Workstation update (2026-10-11): the user reports that the long-receipt retry worked. This is a successful hardware report; the broader length/resolution/readability test matrix remains pending.

### Revision 2: post-page polling

The user's reported `a73697fc` bundle contains a complete image with successful EOF; `2f146def` is a separate zero-image attempt started about four seconds later with a parameter-acquisition jam. The original image was retained, but the collector focused the newer failure.

`epsonds-session.patch` fixes two backend paths that reproduce this sequence:

- Parse space-padded feeder-empty (`ADF PE`) and cover-open status fields correctly. The previous comparison included the literal's terminating NUL when the firmware supplied a padded four-byte code, so it could mistake an empty feeder for ready and start a transfer that then reported a jam. Preserve genuine jam and unknown error statuses as faults.
- Honor pending cancellation before starting another page. A page-end reply need not include `lft`; the old code cleared the cancel marker and could resume the preceding data session. End that job before polling readiness, propagate cancel errors, and release residual page buffers.

The bundle identifies itself as `receipt-longpaper-2` in provenance and the collector status. No image transformations or missing-row padding are introduced. Browser-only changes also treat start-phase Busy as a waiting state and avoid diagnostic samples for an ordinary user Stop before any pixels return. Genuine faults and partial images are still retained.

## Verification

The patched C backend was compiled and tested in Chromium using a simulated RR-70W USB/eSCI-2 transport. With a simulated 1,000 mm receipt, the normal 508 mm profile reports `PJ`; the long profile requests 1,200 mm, emits advertised `PEDT`, and returns exactly the actual 1,000 mm of unchanged 8-bit RGB data at default 200 DPI. A missing row is rejected, and reopening restores the normal profile. Regression tests cover padded empty-feeder status, optional `lft`, and three receipts followed by repeated idle/busy polls. UI tests verify genuine diagnostic export and preservation of the last receipt preview when a later fault occurs. These are protocol/implementation checks, not a physical scanner test.

```sh
npm ci
npx playwright install chromium
npm run test:scanner-browser
```

The browser tests require the generated patched bundle. `npm run test:samples` separately checks the JavaScript capture/configuration and local-server failure paths without Chromium.

## Rebuild

Node/npm is not needed for driver compilation. The build requires Python 3.9+, Git, and Docker:

```sh
python3 scripts/build-scanner-driver.py
```

This clones a temporary pinned checkout, applies both patches, compiles using Emscripten 3.1.50, and packages `scanner-driver/build`. It does not modify the installed npm package, legacy `build/`, or `dist/`.

Source pins:

- sane-wasm: `067b5576f1dde4433c17a29fa6bbaba762c021a8` (`v0.5.0`).
- SANE backends: `32f335d0f1bb9f4fa25fdab722d0201043614df3`.
- libusb/libjpeg submodules and upstream dependency patches: from that pinned sane-wasm checkout.
- Compiler base: `emscripten/emsdk:3.1.50`, digest pinned in `Dockerfile.builder`.

For a source distribution, include both patches/build script alongside the corresponding pinned upstream sources and their licenses. Changes are limited to the four `epsonds` source files shown in the patches; retain an unmodified npm-driver rollback path.

## Retry on the workstation

1. Disconnect the scanner in the collector and clear any paper still in the feeder.
2. Restart `python3 sample-server.py`; its startup output should select `scanner-driver/build`.
3. Refresh the collector and reconnect. The scanner status must show **Long-paper option: available**.
4. Check **Long receipt**, set maximum length to **1,200 mm**, and select **200 DPI** for the first retry.
5. Start capture and inspect the physical receipt's bottom and full-resolution strips. A reported EOF is not that physical check.

If it still fails, the failed attempt is saved with source options, applied changes, operation/status codes, and any bytes the driver returned. Diagnostic-only attempts have an empty `original.bin`, no image dimensions, and `transport_complete: false`. Export that ZIP along with whether the paper physically stopped and approximately how far it fed.

To compare with the unmodified driver:

```sh
python3 sample-server.py --driver-dir node_modules/sane-wasm/build
```

Uncheck Long receipt for that comparison; the unmodified driver exposes no such option.
