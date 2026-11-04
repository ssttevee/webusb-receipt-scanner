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

The application creates a lossless reference master and evidence-backed date/time proposals. Supported proposals prefill staging fields; Save review confirms or corrects them before approval. Ambiguous/unsupported sources stay in review. Enhanced-master ranking and staged revisions of approved exports remain subsequent work.

See the [53-sample extraction baseline](docs/plans/receipt-extraction-baseline-2026-11-03.md) for measured proposal coverage, review cases and limits.

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
