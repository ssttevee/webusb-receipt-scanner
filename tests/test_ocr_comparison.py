import hashlib
import json
from types import SimpleNamespace
import uuid
import zipfile

import numpy as np
from PIL import Image
import pytest

from server.ocr_backends import RapidCPU, TesseractAPI
from server.ocr_compare import code_fingerprint, distribution, freeze, primary_review
from server.ocr_models import verify_models
from server.recognition import lines_from_words, recognize


def api_fixture():
    instances = []
    class API:
        def __init__(self, **settings):
            self.settings, self.calls = settings, []
            self.ended = False
            instances.append(self)

        def SetVariable(self, *args):
            self.calls.append(("variable", args))

        def ClearAdaptiveClassifier(self):
            self.calls.append("reset_adaptation")

        def SetPageSegMode(self, psm):
            self.calls.append(("psm", psm))

        def SetImage(self, image):
            self.calls.append(("image", image.size))

        def SetSourceResolution(self, dpi):
            self.calls.append(("dpi", dpi))

        def Recognize(self, timeout):
            self.calls.append(("timeout", timeout))

        def GetTSVText(self, page):
            return "5\t1\t1\t1\t1\t1\t10\t10\t70\t15\t90\t2026-09-14\n5\t1\t1\t1\t1\t2\t90\t10\t70\t15\t90\t17:21:30\n"

        def Clear(self):
            self.calls.append("clear")

        def End(self):
            self.ended = True
    return SimpleNamespace(__name__="fixture", PyTessBaseAPI=API, tesseract_version=lambda: "tesseract 5.3.0"), instances


def test_persistent_api_reuses_profiles_and_resets_cross_receipt_state(tmp_path):
    module, instances = api_fixture()
    backend = TesseractAPI(tessdata=tmp_path, capacity=2, api_module=module)
    image = Image.new("L", (200, 80), "white")
    for profile in (("eng",), ("fra",), ("eng",), ("jpn",)):
        output = backend.read(image, profile=profile, dpi=200, psm=6, timeout=1)
        assert output["tsv"].startswith("level\t")
    assert backend.initializations == 3
    assert instances[0].calls.count("reset_adaptation") == 2
    assert instances[0].calls.count("clear") == 2
    assert ("timeout", 1000) in instances[0].calls
    assert instances[1].ended and not instances[0].ended  # LRU eviction.
    backend.close()
    assert all(instance.ended for instance in instances)


def test_persistent_engine_uses_the_unchanged_evidence_gate(tmp_path):
    module, _ = api_fixture()
    backend = TesseractAPI(tessdata=tmp_path, api_module=module)
    output = recognize(Image.new("L", (200, 80), "white"), backend=backend)
    assert output["failures"] == []
    assert output["extraction"]["selected"]["time"] == "17:21:30"
    assert output["extraction"]["review_required"] is True
    assert output["backend"]["kind"] == "tesserocr"
    backend.close()


def test_native_failure_clears_the_api_and_cannot_propose_fields(tmp_path):
    module, instances = api_fixture()
    def unavailable(*args, **kwargs):
        raise RuntimeError("native timeout")
    original = module.PyTessBaseAPI
    def failing_api(**settings):
        api = original(**settings)
        api.Recognize = unavailable
        return api
    module.PyTessBaseAPI = failing_api
    backend = TesseractAPI(tessdata=tmp_path, api_module=module)
    output = recognize(Image.new("L", (200, 80), "white"), backend=backend)
    assert output["extraction"]["selected"] is None
    assert "incomplete_ocr_coverage" in output["extraction"]["issues"]
    assert instances[0].calls.count("clear") == 2
    backend.close()


def test_rapid_boxes_and_scores_map_to_original_coordinates():
    backend = RapidCPU.__new__(RapidCPU)
    backend.initialized = True
    backend.ocr = lambda image: SimpleNamespace(boxes=np.array([[[10.2, 20.1], [150, 19.9], [151, 40], [9.8, 41]]]),
                                               txts=("2026-09-14 17:21",), scores=(0.97,))
    result = backend.read(Image.new("RGB", (200, 100), "white"), profile=["eng"], dpi=200, psm=11, timeout=2)
    lines = lines_from_words(result["words"], "rapid", x=30, y=1400)
    assert lines[0].box == (39, 1419, 181, 1441)
    assert lines[0].confidence == 97
    assert lines[0].text == "2026-09-14 17:21"
    assert not backend.supports_psm


def test_model_checksum_failure_does_not_download_replacements(tmp_path, monkeypatch):
    import server.ocr_models as models
    good = b"public-model-fixture"
    (tmp_path / "test.onnx").write_bytes(good)
    monkeypatch.setattr(models, "MODELS", {"det": {"file": "test.onnx", "sha256": hashlib.sha256(good).hexdigest()}})
    assert verify_models(tmp_path)["det"].name == "test.onnx"
    (tmp_path / "test.onnx").write_bytes(b"modified")
    with pytest.raises(ValueError, match="checksum"):
        verify_models(tmp_path)


def test_frozen_cohort_rejects_label_drift(tmp_path):
    samples, output = tmp_path / "samples", tmp_path / "output"
    samples.mkdir()
    identity = str(uuid.uuid4())
    manifest = {"id": identity, "source": {"kind": "scanner-raw", "sha256": "a" * 64},
                "labels": {"state": "confirmed", "date": "2026-09-14", "time": "17:21"}}
    bundle = samples / f"sample-{identity}.zip"
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
    assert freeze(samples, output) == freeze(samples, output)
    manifest["labels"]["time"] = "17:22"
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
    with pytest.raises(ValueError, match="corpus changed"):
        freeze(samples, output)


def test_primary_review_categories_keep_policy_and_source_defects_separate():
    assert primary_review(["no_supported_timestamp"], expected_review=True) == "expected_source_review"
    assert primary_review(["missing_complete_timestamp", "two_digit_year_requires_century"]) == "date_policy"
    assert distribution([])["p95"] is None
    assert distribution([1, 2, 3])["median"] == 2


def test_comparison_cache_fingerprint_includes_scoring_and_metrics_code(tmp_path):
    for name in ("recognition.py", "extraction.py", "ocr_backends.py", "benchmark.py", "ocr_compare.py", "ocr_pipeline.py", "ocr_fallback.py"):
        (tmp_path / name).write_text("original")
    first = code_fingerprint(tmp_path)
    (tmp_path / "benchmark.py").write_text("different scoring")
    assert code_fingerprint(tmp_path) != first
    second = code_fingerprint(tmp_path)
    (tmp_path / "ocr_compare.py").write_text("different metrics")
    assert code_fingerprint(tmp_path) != second
