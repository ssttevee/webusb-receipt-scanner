import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from unittest.mock import patch
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("sample_server", Path(__file__).resolve().parents[1] / "sample-server.py")
sample_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample_server)
ID = "11111111-1111-4111-8111-111111111111"


def bundle(data=b"raw pixels", date=None, hash_override=None):
    manifest = {"schema_version": 1, "id": ID, "source": {
        "artifact": "original.bin", "byte_length": len(data),
        "sha256": hash_override or hashlib.sha256(data).hexdigest(),
    }, "labels": {"date": date}}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("original.bin", data)
        archive.writestr("manifest.json", json.dumps(manifest))
    return output.getvalue()


class SampleServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.samples = Path(self.temporary.name) / "samples"
        handler = sample_server.make_handler(Path(self.temporary.name), self.samples)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.save_lock = threading.Lock()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def upload(self, data, origin=None):
        request = urllib.request.Request(f"{self.origin}/api/samples/{ID}", data=data, method="PUT", headers={
            "Content-Type": "application/zip", "Origin": origin or self.origin,
        })
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def delete(self, sample_id=ID, origin=None):
        request = urllib.request.Request(f"{self.origin}/api/samples/{sample_id}", method="DELETE", headers={
            "Origin": origin or self.origin,
        })
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_delete_targets_one_sample_and_is_safe_to_retry(self):
        self.assertEqual(self.upload(bundle())[0], 200)
        other = self.samples / "sample-22222222-2222-4222-8222-222222222222.zip"
        other.write_bytes(b"another sample")
        status, result = self.delete()
        self.assertEqual(status, 200)
        self.assertEqual(result["id"], ID)
        self.assertTrue(result["deleted"] and result["removed"] and result["durable"])
        self.assertFalse((self.samples / f"sample-{ID}.zip").exists())
        self.assertEqual(other.read_bytes(), b"another sample")
        status, result = self.delete()
        self.assertEqual(status, 200)
        self.assertTrue(result["deleted"] and result["durable"])
        self.assertFalse(result["removed"])

    def test_delete_validates_origin_id_and_reports_filesystem_failure(self):
        self.assertEqual(self.upload(bundle())[0], 200)
        self.assertEqual(self.delete(origin="https://other.example")[0], 403)
        self.assertEqual(self.delete(sample_id="not-a-sample-id")[0], 404)
        with patch.object(Path, "unlink", side_effect=PermissionError("test delete denied")):
            status, result = self.delete()
        self.assertEqual(status, 507)
        self.assertNotIn("deleted", result)
        self.assertTrue((self.samples / f"sample-{ID}.zip").exists())

    def test_delete_missing_sample_does_not_create_storage(self):
        self.assertFalse(self.samples.exists())
        status, result = self.delete()
        self.assertEqual(status, 200)
        self.assertTrue(result["deleted"] and result["durable"])
        self.assertFalse(self.samples.exists())

    def test_save_retry_and_label_revision_preserve_original(self):
        for date in [None, None, "2021-09-14"]:
            status, response = self.upload(bundle(date=date))
            self.assertEqual(status, 200)
            self.assertTrue(response["durable"])
        self.assertEqual(len(list(self.samples.glob("*.zip"))), 1)
        with zipfile.ZipFile(self.samples / f"sample-{ID}.zip") as archive:
            self.assertEqual(archive.read("original.bin"), b"raw pixels")
            self.assertEqual(json.loads(archive.read("manifest.json"))["labels"]["date"], "2021-09-14")
        self.assertEqual(self.upload(bundle(data=b"different pixels"))[0], 409)
        self.assertEqual(list(self.samples.glob(".upload-*")), [])

    def test_rejects_corrupt_checksum_and_wrong_origin(self):
        self.assertEqual(self.upload(bundle(hash_override="0" * 64))[0], 400)
        self.assertEqual(self.upload(bundle(), origin="https://other.example")[0], 403)
        self.assertEqual(self.upload(b"not a zip")[0], 400)

    def test_static_isolation_headers_and_no_sample_file_exposure(self):
        with urllib.request.urlopen(f"{self.origin}/sample-input.html") as response:
            self.assertEqual(response.headers["Cross-Origin-Opener-Policy"], "same-origin")
            self.assertEqual(response.headers["Cross-Origin-Embedder-Policy"], "require-corp")
            self.assertIn(b"Connect scanner", response.read())
        with self.assertRaises(urllib.error.HTTPError) as result:
            urllib.request.urlopen(f"{self.origin}/.receipt-samples/sample-{ID}.zip")
        self.assertEqual(result.exception.code, 404)
        result.exception.close()


if __name__ == "__main__":
    unittest.main()
