import io

import numpy as np
from PIL import Image

from server.enhance import binarize, enhanced_page, trim_right


def synthetic_scan():
    gray = np.full((300, 200), 210, dtype=np.uint8)
    gray[60:180, 20:150] = 30           # printed text block
    gray[:220, 170:] = 10               # dark background beside the paper edge
    gray[220:, :] = 255                 # blank white feed below the receipt
    return gray


def write_master(tmp_path, gray):
    path = tmp_path / "master.tiff"
    Image.fromarray(gray, mode="L").save(path, format="TIFF", compression="tiff_deflate", dpi=(200, 200))
    return path


def test_enhanced_page_crops_dark_edge_and_blank_feed_then_binarizes(tmp_path):
    master = write_master(tmp_path, synthetic_scan())
    enhanced = Image.open(io.BytesIO(enhanced_page(master)))
    assert enhanced.mode == "1"
    assert enhanced.width == 170 and enhanced.height == 220
    pixels = np.asarray(enhanced.convert("L"))
    assert pixels[100, 30] == 0 and pixels[5, 5] == 255


def test_binarize_keeps_faint_strokes_under_uneven_illumination():
    columns = np.arange(120, dtype=np.uint8)
    gray = np.tile(130 + columns, (80, 1))
    gray[:, 60:64] = (130 + columns)[60:64] - 80
    binary = binarize(gray, window=51)
    assert not binary[40, 61] and not binary[10, 62]
    assert binary[40, 30] and binary[40, 90]


def test_trim_right_never_splits_the_page():
    gray = np.full((100, 200), 210, dtype=np.uint8)
    gray[:, 100] = 10                   # a dark printed column mid-page
    assert trim_right(gray).shape[1] == 200
    gray[:, 180:] = 10                  # genuine dark background beyond the paper edge
    assert trim_right(gray).shape[1] == 180


def test_trim_right_cuts_wide_dark_background_for_a_narrow_receipt():
    gray = np.full((300, 1000), 210, dtype=np.uint8)
    gray[:, :300] = 245
    gray[:, 300:] = 5                   # dark background beyond 30% of the width
    gray[:, 995:] = 245                 # thin white fringe at the scan edge
    assert trim_right(gray).shape[1] == 300
