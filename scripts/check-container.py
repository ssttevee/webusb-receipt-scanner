"""Isolated amd64 image smoke test, optionally using one private raw sample ZIP.

Creates only uniquely named test containers/volumes; no Drive or model calls.
"""
import argparse
import hashlib
import io
import json
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
import zipfile

import pikepdf
from PIL import Image, ImageDraw


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="receipt-scanner:dev")
    parser.add_argument("--bundle", help="Optional private scanner-raw sample, used only inside disposable test volumes")
    parser.add_argument("--fallback-timeout", type=int)
    parser.add_argument("--expect-fallback-state", choices=("accepted", "no_proposal", "skipped", "timeout"))
    parser.add_argument("--languages", nargs="+", choices=("eng", "fra", "jpn", "chi_tra", "chi_sim"),
                        default=["eng", "fra", "jpn", "chi_tra", "chi_sim"])
    parser.add_argument("--reprocess-mode", choices=("parse", "ocr"))
    parser.add_argument("--date-order", choices=("MDY", "DMY", "YMD"))
    parser.add_argument("--century", type=int, choices=(1900, 2000))
    args = parser.parse_args()
    assert docker("image", "inspect", args.image, "--format", "{{.Architecture}}") == "amd64"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    name = "receipt-check-" + uuid.uuid4().hex[:12]
    volumes = {path: name + "-" + path for path in ("state", "work", "archive", "samples")}

    def start():
        mounts = [arg for path, volume in volumes.items() for arg in ("-v", f"{volume}:/{path}")]
        environment = ["-e", f"OCR_FALLBACK_TIMEOUT_SECONDS={args.fallback_timeout}"] if args.fallback_timeout else []
        docker("run", "-d", "--platform", "linux/amd64", "--name", name, "--memory", "8g", "-p", f"127.0.0.1:{port}:8000",
               "-e", f"APP_PUBLIC_URL={origin}", *environment, *mounts, args.image)
        for _ in range(150):
            try:
                if request("GET", "/api/health")["ok"]:
                    return
            except (urllib.error.URLError, ConnectionError):
                pass
            time.sleep(0.2)
        raise RuntimeError("Container API did not become ready")

    def request(method, path, value=None, binary=False):
        data = value if binary else json.dumps(value or {}).encode() if method != "GET" else None
        response = urllib.request.urlopen(urllib.request.Request(origin + path, data=data, method=method,
            headers={"Origin": origin, "Content-Type": "application/octet-stream" if binary else "application/json"}), timeout=120)
        assert response.headers["Cross-Origin-Opener-Policy"] == "same-origin"
        assert response.headers["Cross-Origin-Embedder-Policy"] == "require-corp"
        return json.load(response) if "application/json" in response.headers["Content-Type"] else response.read()

    if args.bundle:
        with zipfile.ZipFile(args.bundle) as archive:
            sample = json.loads(archive.read("manifest.json"))
            source = sample["source"]
            assert source["kind"] == "scanner-raw"
            data = archive.read(source["artifact"])
            scanner = source["scanner"]
            manifest = {"kind": "scanner-raw", "width": source["dimensions"]["width"], "height": source["dimensions"]["height"],
                        "frame": scanner["parameters"], "dpi_x": scanner["resolution"]["x"], "dpi_y": scanner["resolution"]["y"]}
            labels = sample["labels"]
    else:
        image = Image.new("RGB", (640, 1200), "white")
        draw = ImageDraw.Draw(image)
        draw.text((30, 60), "Synthetic receipt\n2026-09-14 17:21:30\nBOTTOM", fill="black", font_size=30)
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        data = stream.getvalue()
        manifest = {"kind": "image", "width": 640, "height": 1200, "dpi_x": 200, "dpi_y": 200}
        labels = {"date": "2026-09-14", "time": "17:21:30"}
    identity = str(uuid.uuid4())
    checksum = hashlib.sha256(data).hexdigest()
    manifest.update(id=identity, byte_length=len(data), sha256=checksum, transport_complete=True,
                    languages=args.languages)
    try:
        start()
        packs = docker("exec", name, "tesseract", "--list-langs")
        assert all(language in packs for language in ("eng", "fra", "jpn", "chi_tra", "chi_sim"))
        session = request("POST", "/api/captures", manifest)
        chunk_size = session["chunk_size"]
        request("PUT", f"/api/captures/{identity}/chunks/0", data[:chunk_size], binary=True)
        docker("stop", "-t", "25", name)
        docker("rm", name)
        start()
        resumed = request("POST", "/api/captures", manifest)
        assert resumed["received"] == [0]
        for index in range(1, (len(data) + chunk_size - 1) // chunk_size):
            request("PUT", f"/api/captures/{identity}/chunks/{index}", data[index * chunk_size:(index + 1) * chunk_size], binary=True)
        assert request("POST", f"/api/captures/{identity}/finalize")["sha256"] == checksum
        for _ in range(240):
            state = request("GET", "/api/state")
            group = state["groups"][0]
            if group["receipts"][0]["state"] == "ready":
                break
            if any(job["state"] == "failed" for job in state["jobs"]):
                raise RuntimeError("Container image processing failed")
            time.sleep(0.5)
        else:
            raise RuntimeError("Container image processing timed out")
        evidence = request("GET", f"/api/receipts/{identity}/evidence")
        assert evidence["processing"]["ocr"]["state"] == "done"
        assert evidence["processing"]["ocr"]["backend"]["kind"] == "tesserocr"
        assert evidence["processing"]["ocr"]["engine"] == "tesseract 5.3.0"
        if args.expect_fallback_state:
            fallback = evidence["processing"]["ocr"]["fallback"]
            assert fallback["state"] == args.expect_fallback_state, fallback["state"]
            if fallback["state"] == "accepted":
                assert evidence["processing"]["extraction"]["routing"]["selected_engine"] == "rapidocr"
                assert fallback["linux_limits"] is True
            if fallback["state"] == "timeout":
                assert fallback["child_stopped"] is True and evidence["processing"]["extraction"]["selected"] is None
                if fallback["child_pid"]:
                    docker("exec", name, "python", "-c", f"from pathlib import Path; assert not Path('/proc/{fallback['child_pid']}').exists()")
        health_command = json.loads(docker("inspect", name, "--format", "{{json .Config.Healthcheck.Test}}"))
        assert health_command[0] == "CMD-SHELL"
        docker("exec", name, "sh", "-c", health_command[1])
        if args.reprocess_mode:
            old_evidence = evidence
            old_id = evidence["analysis"]["id"]
            run = request("POST", f"/api/receipts/{identity}/analyze", {"version": group["version"], "mode": args.reprocess_mode,
                          "date_order": args.date_order, "century": args.century})["analysis"]
            for _ in range(240):
                group = request("GET", "/api/state")["groups"][0]
                current = group["receipts"][0]["analysis"]
                if current["id"] == run["id"] and current["state"] == "ready":
                    break
                if current["state"] == "failed":
                    raise RuntimeError("Reanalysis failed")
                time.sleep(0.5)
            else:
                raise RuntimeError("Reanalysis did not complete")
            evidence = request("GET", f"/api/receipts/{identity}/evidence")
            assert request("GET", f"/api/receipts/{identity}/evidence?analysis_id={old_id}") == old_evidence
            assert evidence["analysis"]["policy"]["effective"] == {"date_order": args.date_order, "century": args.century,
                                                                   "expected_month": evidence["analysis"]["policy"]["requested"].get("expected_month")}
            assert evidence["processing"]["extraction"]["selected"]["date"] == labels["date"]
            if args.reprocess_mode == "parse":
                assert evidence["processing"]["ocr"]["reparse"]["fresh_ocr"] is False
        proposal = evidence["processing"]["extraction"]["selected"]
        assert group["receipts"][0]["date"] == (proposal["date"] if proposal else None)
        assert group["receipts"][0]["timestamp_review"] == 1  # OCR never confirms its own proposal.
        request("POST", f"/api/receipts/{identity}", {"version": group["version"], "date": labels["date"], "time": labels["time"],
                "vendor": None, "complete": True, "readable": True})
        group = request("GET", "/api/state")["groups"][0]
        export = request("POST", f"/api/groups/{group['id']}/prepare", {"version": group["version"]})
        request("POST", f"/api/groups/{group['id']}/approve", {"export_id": export["id"], "version": export["version"]})
        for _ in range(180):
            state = request("GET", "/api/state")
            if state["groups"][0]["state"] == "approved" and all(job["state"] == "done" for job in state["jobs"]):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Container approval/cleanup did not complete")
        pdf = request("GET", f"/api/exports/{export['id']}/pdf")
        with pikepdf.open(io.BytesIO(pdf)) as document:
            assert len(document.pages) == 1
            box = document.pages[0].MediaBox
            page_width, page_height = float(box[2]) - float(box[0]), float(box[3]) - float(box[1])
            assert 0 < page_width <= manifest["width"] * 72 / manifest["dpi_x"] + 0.1
            assert 0 < page_height <= manifest["height"] * 72 / manifest["dpi_y"] + 0.1
            image = pikepdf.PdfImage(next(iter(document.pages[0].images.values())))
            assert "CCITTFaxDecode" in str(image.obj["/Filter"])
            assert image.pil_mode == "1" or image.bits_per_component == 1
        docker("stop", "-t", "25", name)
        docker("rm", name)
        start()
        assert hashlib.sha256(request("GET", f"/api/exports/{export['id']}/pdf")).hexdigest() == hashlib.sha256(pdf).hexdigest()
        assert request("GET", "/api/state")["groups"][0]["state"] == "approved"
        print("PASS: amd64 container, five OCR packs, chunk resume after recreation, OCR evidence, manual review, approval, physical PDF size, cleanup and approved artifact recovery.")
        if args.bundle:
            print("PASS: embedded real receipt PDF page is a bilevel CCITT enhancement within the original bounds.")
        if args.reprocess_mode:
            print("PASS: explicit receipt convention, durable reanalysis, immutable history and unconfirmed proposal before manual approval.")
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        for volume in volumes.values():
            subprocess.run(["docker", "volume", "rm", volume], capture_output=True)


if __name__ == "__main__":
    main()
