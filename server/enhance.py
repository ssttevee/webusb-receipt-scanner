"""Approved-PDF page enhancement per the automation architecture plan: cautious
geometry (blank-feed bottom trim, dark-edge suffix crop), local Sauvola
thresholding via bounded integral-image statistics, and no unconditional corner
filling. Reference masters stay lossless; ranking enhanced candidates against the
reference remains subsequent work."""
import io
from pathlib import Path

import numpy as np
from PIL import Image


def trim_bottom(gray, fill=(255, 128)):
    column = gray[:, -1]
    bottom = gray.shape[0]
    while bottom and int(column[bottom - 1]) in fill:
        bottom -= 1
    return gray[:bottom or gray.shape[0]]


def trim_right(gray, threshold=0.3, maximum=0.25):
    """Cut only a dark suffix of columns at the right edge; never split the page."""
    limit = int(gray.shape[1] * max(0.0, min(1.0, maximum)))
    right = gray.shape[1]
    means = gray.mean(axis=0)
    while right > gray.shape[1] - limit and means[right - 1] < threshold * 255:
        right -= 1
    return gray[:, :right]


def binarize(gray, window=51, k=0.34, dynamic_range=128.0):
    """Sauvola thresholding: white where pixel > mean * (1 + k * (std / R - 1))."""
    if window < 3 or window % 2 == 0:
        raise ValueError("Window size must be an odd number of at least 3")
    pad = window // 2
    padded = np.pad(gray, pad, mode="edge")
    height, width = gray.shape

    def integral(values):
        totals = np.zeros((padded.shape[0] + 1, padded.shape[1] + 1), dtype=np.uint64)
        totals[1:, 1:] = values.cumsum(axis=0).cumsum(axis=1)
        return (totals[window:window + height, window:window + width] - totals[:height, window:window + width]
                - totals[window:window + height, :width] + totals[:height, :width])

    mean = integral(padded) / (window * window)
    squared = integral(padded.astype(np.uint64) ** 2) / (window * window)
    deviation = np.sqrt(np.maximum(squared - mean * mean, 0.0))
    return gray > mean * (1.0 + k * (deviation / dynamic_range - 1.0))


def enhanced_page(source, dpi=None):
    source = Path(source)
    with Image.open(source) as opened:
        dpi = tuple(dpi or opened.info.get("dpi") or (200.0, 200.0))
        gray = np.asarray(opened.convert("L"))
    gray = trim_right(trim_bottom(gray))
    if not gray.size:
        raise ValueError(f"Scan {source} has no printable area after cropping")
    binary = Image.fromarray(np.where(binarize(gray), 255, 0).astype(np.uint8), mode="L")
    binary = binary.convert("1", dither=Image.Dither.NONE)
    buffer = io.BytesIO()
    binary.save(buffer, format="TIFF", compression="group4", dpi=tuple(round(float(value), 4) for value in dpi))
    return buffer.getvalue()
