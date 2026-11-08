# Receipt scanner

Browser-connected Epson RR-70W capture, durable server processing, manual staging/grouping, approved PDFs and optional Google Drive delivery.

## Application

Build the pinned patched scanner assets first if `scanner-driver/build/` is absent:

```sh
python3 scripts/build-scanner-driver.py
```

Build the amd64 application image:

```sh
docker build --platform linux/amd64 -t receipt-scanner:dev .
```

Run locally with persistent Docker volumes:

```sh
docker run --rm --name receipt-scanner --platform linux/amd64 \
  -p 127.0.0.1:8000:8000 --memory 8g \
  -e APP_PUBLIC_URL=http://localhost:8000 \
  -v receipt-state:/state -v receipt-work:/work \
  -v receipt-samples:/samples -v receipt-archive:/archive \
  receipt-scanner:dev
```

Open **http://localhost:8000** in desktop Chrome/Edge. The USB device stays on the workstation. The UI provides scanning, pending-transfer recovery, full-resolution inspection, manual date/time review, combine/split/reorder, deletion of bad scans from staging, version-bound approval, PDF download and explicit Drive delivery.

New scans assume the current century for two-digit years. Set **Scan year century** before a session or import to change that choice. The browser retains it for later scans. Each capture records its century; printed four-digit years remain unchanged.

The application creates a lossless reference master and evidence-backed date/time proposals. Supported proposals prefill staging fields; Save review confirms or corrects them before approval. Ambiguous/unsupported sources stay in review. When the proposals need no changes, **Confirm ready pages** attests the physical bottom and readability for the whole batch at once after a count and date-range preview, and **Approve ready groups** queues the PDF for each confirmed group in one action. Enhanced-master ranking and staged revisions of approved exports remain subsequent work.

See the [53-sample extraction baseline](docs/plans/receipt-extraction-baseline-2026-11-03.md) for measured proposal coverage, review cases and limits.

The Docker worker now uses persistent Tesseract APIs. The [CPU OCR comparison](docs/plans/receipt-ocr-comparison-2026-11-03.md) records the speed/memory tradeoff and the RapidOCR challenger results.

For selective RapidOCR fallback, build `Dockerfile.ocr` after the base image:

```sh
docker build --platform linux/amd64 -f Dockerfile.ocr -t receipt-scanner:ocr .
```

Use `receipt-scanner:ocr` with the same run command and mounts. Its [combined-corpus result](docs/plans/receipt-selective-fallback-2026-11-06.md) is 31 matching proposals and 22 review cases. The fallback has a hard inference deadline and a bounded child process. The base `:dev` image keeps the smaller primary-only path.

Staged receipts also support explicit date conventions, saved-OCR reparse, fresh OCR and immutable analysis history. The [policy-assisted experiment](docs/plans/receipt-convention-reanalysis-2026-11-06.md) reached 40 matching proposals from 53 receipts with nine supplied conventions. Those conventions are explicit operator inputs; timestamp confirmation remains mandatory.

See [runtime and development instructions](docs/application-runtime.md) for volumes, OAuth, checks, recovery and current verification limits.

## Workstation sample collector

```sh
npm ci
python3 sample-server.py
```

Open **http://localhost:8000/sample-input.html**. This separate development utility writes private ZIPs under `.receipt-samples/` without Docker. See [sample instructions](docs/sample-capture.md).

## Legacy prototype

The original static prototype can still be served with:

```sh
npx -p http-server-rs@0.0.6 http-server-rs -S .
```

Use **Delete scan** on a staging page to discard a bad feed, then confirm and scan it again. If image processing is running, retry deletion after it finishes. Deleting a page invalidates any prepared approval for its group; approved scans cannot be deleted.
