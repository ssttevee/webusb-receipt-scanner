"""Optional CPU OCR adapters for controlled comparisons."""
from collections import OrderedDict
from importlib.metadata import version
import math
from pathlib import Path
import time

import numpy as np

from .ocr_models import MODELS, verify_models
from .storage import digest

TSV_HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"


class TesseractAPI:
    supports_psm = True

    def __init__(self, tessdata="/usr/share/tesseract-ocr/5/tessdata", capacity=3, api_module=None):
        started = time.perf_counter()
        if api_module is None:
            import tesserocr as api_module
        self.module = api_module
        self.tessdata = str(tessdata)
        self.capacity = capacity
        self.pool = OrderedDict()
        self.initializations = 0
        self.engine = api_module.tesseract_version().splitlines()[0]
        self.startup_seconds = time.perf_counter() - started
        self.descriptor = {"kind": "tesserocr", "package": version("tesserocr") if api_module.__name__ == "tesserocr" else "fixture",
                           "engine": self.engine, "profile_cache_capacity": capacity, "adaptive_learning": False,
                           "tessdata_sha256": {path.stem: digest(path) for path in Path(tessdata).glob("*.traineddata") if path.stem in ("eng", "fra", "jpn", "chi_tra", "chi_sim")}}

    def read(self, image, *, profile, dpi, psm, timeout):
        key = "+".join(profile)
        initialized = 0.0
        if key not in self.pool:
            started = time.perf_counter()
            api = self.module.PyTessBaseAPI(path=self.tessdata, lang=key)
            api.SetVariable("classify_enable_learning", "0")
            api.SetVariable("debug_file", "/dev/null")
            self.pool[key] = api
            self.initializations += 1
            if len(self.pool) > self.capacity:
                _, evicted = self.pool.popitem(last=False)
                evicted.End()
            initialized = time.perf_counter() - started
        api = self.pool[key]
        self.pool.move_to_end(key)
        try:
            api.ClearAdaptiveClassifier()
            api.SetPageSegMode(psm)
            api.SetImage(image)
            api.SetSourceResolution(dpi)
            api.Recognize(timeout=max(1, int(timeout * 1000)))
            text = api.GetTSVText(0)
            if not text.startswith("level\t"):
                text = TSV_HEADER + text
            return {"tsv": text, "initialization_seconds": initialized}
        finally:
            api.Clear()

    def close(self):
        for api in self.pool.values():
            api.End()
        self.pool.clear()


class RapidCPU:
    supports_psm = False

    def __init__(self, models="/opt/receipt-ocr-models", factory=None):
        started = time.perf_counter()
        paths = verify_models(models)
        if factory is None:
            from rapidocr import RapidOCR as factory
        from rapidocr.utils.typings import LangDet, LangRec, ModelType, OCRVersion
        import cv2
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        cv2.setNumThreads(2)
        self.engine = f"RapidOCR {version('rapidocr')} / ONNX Runtime {onnxruntime.__version__} / PP-OCRv6-small"
        self.ocr = factory(params={
            "Global.use_cls": False, "Global.log_level": "critical", "Global.text_score": 0.5,
            "Global.max_side_len": 2000,
            "Det.ocr_version": OCRVersion.PPOCRV6, "Det.model_type": ModelType.SMALL, "Det.lang_type": LangDet.MULTI,
            "Det.model_path": str(paths["det"]), "Det.limit_side_len": 736,
            "Rec.ocr_version": OCRVersion.PPOCRV6, "Rec.model_type": ModelType.SMALL, "Rec.lang_type": LangRec.CH,
            "Rec.model_path": str(paths["rec"]),
            "EngineConfig.onnxruntime.intra_op_num_threads": 2,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            "EngineConfig.onnxruntime.use_cuda": False,
        })
        self.initialized = False
        self.startup_seconds = time.perf_counter() - started
        self.descriptor = {"kind": "rapidocr", "engine": self.engine, "threads": {"intra_op": 2, "inter_op": 1},
                           "detection_short_side": 736, "maximum_input_side": 2000, "orientation_classifier": False,
                           "text_score": 0.5, "opencv_threads": 2,
                           "model_sha256": {kind: model["sha256"] for kind, model in MODELS.items()}}

    def read(self, image, *, profile, dpi, psm, timeout):
        started = time.perf_counter()
        initialized = 0.0
        if not self.initialized:
            self.ocr._load_det_model()
            self.ocr._load_rec_model()
            for model in (self.ocr.text_det, self.ocr.text_rec):
                if model.session.session.get_providers() != ["CPUExecutionProvider"]:
                    raise ValueError("The comparison requires CPU-only ONNX execution")
            initialized = time.perf_counter() - started
            self.initialized = True
        # RapidOCR receives BGR input and returns coordinates in that input.
        pixels = np.asarray(image.convert("RGB"))[:, :, ::-1].copy()
        result = self.ocr(pixels)
        if time.perf_counter() - started > timeout:
            raise TimeoutError("OCR pass exceeded the receipt time budget")
        words = []
        if result.boxes is not None:
            for box, text, confidence in zip(result.boxes, result.txts, result.scores):
                if not math.isfinite(float(confidence)) or not 0 <= confidence <= 1:
                    raise ValueError("Invalid detector/recognizer confidence")
                coordinates = np.asarray(box)
                left, top = np.floor(coordinates.min(axis=0)).astype(int)
                right, bottom = np.ceil(coordinates.max(axis=0)).astype(int)
                words.append({"text": text, "box": (max(0, int(left)), max(0, int(top)), min(image.width, int(right)), min(image.height, int(bottom))),
                              "confidence": float(confidence) * 100})
        return {"words": words, "initialization_seconds": initialized}

    def close(self):
        self.ocr = None
