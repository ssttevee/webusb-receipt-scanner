"""RA-11 bounded, versioned binarization candidates for one printed timestamp region.

Every recipe maps an 8-bit grayscale crop to an image for the next OCR read, and the reference
recipe never alters a pixel: ranking can therefore always measure whether a binarized result
actually beat what was printed. Everything here is pure and bounded to the crop that was sent -
page-wide enhancement stays in enhance.py. Ranking belongs to the caller: selecting a winner is
a proposal, never a ruling."""
import io
import numpy as np
from PIL import Image

VERSION = "binarize-candidates-v2"


def reference(gray):
    """The unchanged grayscale crop, so any ranking can detect detail loss in the others."""
    return gray


def stretched(gray, window=51, target=128.0):
    """Divide out slow illumination with a bounded local mean, then stretch contrast.
    Faint print on shaded paper separates without the local window eating the strokes."""
    height, width = gray.shape
    pad = window // 2
    padded = np.pad(gray, pad, mode="edge")
    totals = np.zeros((padded.shape[0] + 1, padded.shape[1] + 1), dtype=np.uint64)
    totals[1:, 1:] = padded.cumsum(axis=0).cumsum(axis=1)
    mean = (totals[window:window + height, window:window + width] - totals[:height, window:window + width]
            - totals[window:window + height, :width] + totals[:height, :width]) / float(window * window)
    normalized = np.clip(gray / np.maximum(mean, 1.0) * target, 0.0, 255.0)
    low, high = np.percentile(normalized, 1.0), np.percentile(normalized, 99.0)
    if high - low < 16.0:  # a blank or noise-only crop must not be stretched into fake ink
        return gray
    return np.clip((normalized - low) * (255.0 / (high - low)), 0.0, 255.0)


def otsu(gray, bins=256):
    """One global threshold: the safest binarization for a flat, evenly lit stamp."""
    histogram = np.bincount(gray.ravel(), minlength=bins).astype(np.float64)
    probabilities = histogram / histogram.sum()
    levels = np.arange(bins, dtype=np.float64)
    best_threshold, best_variance = 0.0, -1.0
    for threshold in range(1, bins):
        low, high = probabilities[:threshold], probabilities[threshold:]
        weight_low, weight_high = low.sum(), high.sum()
        if weight_low == 0.0 or weight_high == 0.0:
            continue
        mean_low, mean_high = (levels[:threshold] * low).sum() / weight_low, (levels[threshold:] * high).sum() / weight_high
        variance = weight_low * weight_high * (mean_low - mean_high) ** 2
        if variance > best_variance:
            best_threshold, best_variance = threshold, variance
    return np.where(gray > best_threshold, 255, 0).astype(np.uint8)


def sauvola(gray, window=51, k=0.34, dynamic_range=128.0):
    """Local Sauvola thresholding, shared with the approved-PDF enhancement path."""
    from .enhance import binarize
    return np.where(binarize(gray, window=window, k=k, dynamic_range=dynamic_range), 255, 0).astype(np.uint8)


RECIPES = {
    "reference": {"label": "Unchanged grayscale", "apply": reference, "parameters": {}},
    "stretched": {"label": "Illumination + contrast", "apply": stretched, "parameters": {"window": 51, "target": 128.0}},
    "otsu": {"label": "Global threshold", "apply": otsu, "parameters": {"bins": 256}},
    "sauvola": {"label": "Local (Sauvola)", "apply": sauvola, "parameters": {"window": 51, "k": 0.34}},
}


def apply_recipe(key, gray):
    recipe = RECIPES[key]
    return np.asarray(recipe["apply"](gray, **recipe["parameters"]), dtype=np.uint8)


def png(pixels):
    buffer = io.BytesIO()
    Image.fromarray(pixels, mode="L").save(buffer, format="PNG")
    return buffer.getvalue()
