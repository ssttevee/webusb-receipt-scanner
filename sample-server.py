"""Workstation-only sample capture server. No Docker or third-party Python packages."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD = 270 * 1024 * 1024
SAMPLE_ID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")
STATIC = {
    "/": ("sample-input.html", "text/html"),
    "/sample-input.html": ("sample-input.html", "text/html"),
    "/sample-input.mjs": ("sample-input.mjs", "text/javascript"),
    "/sample-input-utils.mjs": ("sample-input-utils.mjs", "text/javascript"),
    "/raw-scanner.mjs": ("raw-scanner.mjs", "text/javascript"),
}
DRIVER = {"libsane.js": "text/javascript", "libsane.worker.js": "text/javascript", "libsane.wasm": "application/wasm", "provenance.json": "application/json"}
REQUIRED_DRIVER = ("libsane.js", "libsane.worker.js", "libsane.wasm")


def validate_bundle(path, sample_id):
    """Verify the original's hash without extracting receipt files or trusting ZIP paths."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or not 2 <= len(names) <= 3:
            raise ValueError("Expected one original, manifest, and optional preview.")
        if "manifest.json" not in names or archive.getinfo("manifest.json").file_size > 128 * 1024:
            raise ValueError("Missing or oversized manifest.")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("schema_version") != 1 or manifest.get("id") != sample_id:
            raise ValueError("Manifest identity/version does not match.")
        source = manifest["source"]
        artifact = source["artifact"]
        if artifact not in {"original.bin", "original.png", "original.tiff"}:
            raise ValueError("Unsupported original artifact.")
        if set(names) not in ({artifact, "manifest.json"}, {artifact, "manifest.json", "preview.png"}):
            raise ValueError("Unexpected archive files.")
        original = archive.getinfo(artifact)
        if original.file_size > 256 * 1024 * 1024 or source["byte_length"] != original.file_size:
            raise ValueError("Original size does not match its manifest.")
        if "preview.png" in names and archive.getinfo("preview.png").file_size > 8 * 1024 * 1024:
            raise ValueError("Preview is too large.")
        digest = hashlib.sha256()
        with archive.open(artifact) as image:
            for chunk in iter(lambda: image.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != source["sha256"]:
            raise ValueError("Original checksum does not match.")
        return manifest


def make_handler(driver_dir, samples_dir):
    class Handler(BaseHTTPRequestHandler):
        def local_host(self):
            port = self.server.server_port
            return self.headers.get("Host") in {f"localhost:{port}", f"127.0.0.1:{port}"}

        def end_headers(self):
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Permissions-Policy", "usb=(self)")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def respond(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.local_host():
                self.respond(403, {"error": "Use the localhost address"})
                return
            path = urlsplit(self.path).path
            if path in STATIC:
                filename, content_type = STATIC[path]
                file = ROOT / filename
            elif path.startswith("/scanner-assets/") and path.removeprefix("/scanner-assets/") in DRIVER:
                filename = path.removeprefix("/scanner-assets/")
                file, content_type = driver_dir / filename, DRIVER[filename]
            else:
                self.respond(404, {"error": "Not found"})
                return
            try:
                with file.open("rb") as source:
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(file.stat().st_size))
                    self.end_headers()
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        self.wfile.write(chunk)
            except FileNotFoundError:
                self.respond(404, {"error": "Scanner assets missing; run npm install."})

        def sample_write_id(self):
            if not self.local_host():
                self.respond(403, {"error": "Use the localhost address"})
                return None
            sample_id = urlsplit(self.path).path.removeprefix("/api/samples/")
            if not self.path.startswith("/api/samples/") or not SAMPLE_ID.fullmatch(sample_id):
                self.respond(404, {"error": "Invalid sample route"})
                return None
            origin = self.headers.get("Origin")
            expected_origin = f"http://{self.headers.get('Host', '')}"
            if origin != expected_origin:
                self.respond(403, {"error": "Sample writes require the same origin"})
                return None
            return sample_id

        def do_DELETE(self):
            sample_id = self.sample_write_id()
            if sample_id is None:
                return
            destination = samples_dir / f"sample-{sample_id}.zip"
            try:
                with self.server.save_lock:
                    try:
                        destination.unlink()
                        removed = True
                    except FileNotFoundError:
                        removed = False
                    # Also fsync on retry if an earlier unlink succeeded but its
                    # acknowledgment/directory flush failed. A missing folder is idle.
                    if samples_dir.exists():
                        descriptor = os.open(samples_dir, os.O_RDONLY)
                        try:
                            os.fsync(descriptor)
                        finally:
                            os.close(descriptor)
                self.respond(200, {"id": sample_id, "deleted": True, "removed": removed, "durable": True})
            except OSError:
                self.respond(507, {"error": "Could not durably delete sample; browser entry retained for retry"})

        def do_PUT(self):
            sample_id = self.sample_write_id()
            if sample_id is None:
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if self.headers.get("Content-Type") != "application/zip" or not 0 < length <= MAX_UPLOAD:
                self.respond(413, {"error": "Expected a bounded ZIP upload"})
                return
            temporary = None
            try:
                samples_dir.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=samples_dir, prefix=".upload-", delete=False) as output:
                    temporary = Path(output.name)
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(remaining, 1024 * 1024))
                        if not chunk:
                            raise ValueError("Upload ended before its declared length.")
                        output.write(chunk)
                        remaining -= len(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                manifest = validate_bundle(temporary, sample_id)
                destination = samples_dir / f"sample-{sample_id}.zip"
                # Labels may be updated, but this ID can never replace original bytes.
                # Server-wide serialization prevents conflicting concurrent first writes.
                with self.server.save_lock:
                    if destination.exists():
                        previous = validate_bundle(destination, sample_id)
                        if previous["source"]["sha256"] != manifest["source"]["sha256"]:
                            self.respond(409, {"error": "Sample ID already has different original bytes"})
                            return
                    os.replace(temporary, destination)
                    temporary = None
                    descriptor = os.open(samples_dir, os.O_RDONLY)
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                self.respond(200, {"id": sample_id, "sha256": manifest["source"]["sha256"], "durable": True})
            except (ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError):
                self.respond(400, {"error": "Invalid sample bundle or checksum"})
            except OSError:
                self.respond(507, {"error": "Could not durably save sample; browser copy retained"})
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

        def log_message(self, format, *args):
            # IDs/route status only; never log receipt content or labels.
            super().log_message(format, *args)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--samples", type=Path, default=ROOT / ".receipt-samples")
    bundled = ROOT / "scanner-driver/build"
    default_driver = bundled if (bundled / "provenance.json").is_file() else ROOT / "node_modules/sane-wasm/build"
    parser.add_argument("--driver-dir", type=Path, default=default_driver)
    args = parser.parse_args()
    if not all((args.driver_dir / name).is_file() for name in REQUIRED_DRIVER):
        parser.error("Scanner assets missing. Run npm install (sane-wasm 0.5.0), or supply --driver-dir.")
    import threading
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.driver_dir.resolve(), args.samples.resolve()))
    server.save_lock = threading.Lock()
    print(f"Sample collector: http://localhost:{server.server_port}/sample-input.html", flush=True)
    print(f"Workstation sample ZIPs: {args.samples.resolve()}", flush=True)
    print(f"Scanner assets: {args.driver_dir.resolve()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
