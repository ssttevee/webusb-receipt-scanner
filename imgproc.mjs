import opencvPromise from "https://esm.sh/@techstark/opencv-js@4.11.0-release.1";

export const cv = await opencvPromise;

function isFill(pixel) {
  return (
    (pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255) ||
    (pixel[0] === 128 && pixel[1] === 128 && pixel[2] === 128)
  );
}

function trimBottom(img) {
  let bottom = img.rows;
  while (isFill(img.ucharPtr(bottom - 1, img.cols - 1))) {
    bottom -= 1;
  }

  if (!bottom) {
    bottom = img.rows;
  }

  return img.roi(new cv.Rect(0, 0, img.cols, bottom));
}

function trimRight(img, options = undefined) {
  const threshold = options?.threshold ?? 0.3; // black percentage
  const max = options?.max ?? 1; // max width percentage

  let right = img.cols * max;

  for (let i = 0; i < right; i++) {
    const col = img.roi(new cv.Rect(i, 0, 1, img.rows));
    const color = cv.mean(col);
    if ((color[0] + color[1] + color[2]) / 3 / 255 < threshold) {
      right = i;
      break;
    }
  }

  return img.roi(new cv.Rect(0, 0, right, img.rows));
}

function binarize(img, options = undefined) {
  const gray = new cv.Mat();
  try {
    try {
      cv.cvtColor(img, gray, cv.COLOR_BGR2GRAY);
    } catch (cause) {
      throw new Error(`Failed to convert color: ${cause?.message ?? cause}`, { cause });
    }

    const out = new cv.Mat();
    try {
      cv.adaptiveThreshold(
        gray,
        out,
        255,
        cv.ADAPTIVE_THRESH_MEAN_C,
        cv.THRESH_BINARY,
        options?.blockSize ?? 199,
        options?.threshold ?? 60,
      );
    } catch (cause) {
      gray.delete();
      throw new Error(`Failed to adaptive threshold: ${cause?.message ?? cause}`, { cause });
    }
    return out;
  } finally {
    gray.delete();
  }
}

function fillCorners(img) {
  const w = img.cols - 1;
  const h = img.rows - 1;
  const mask = new cv.Mat(img.rows + 2, img.cols + 2, cv.CV_8UC1);
  const scalar = new cv.Scalar(255, 255, 255, 255);
  try {
    cv.floodFill(img, mask, new cv.Point(0, 0), scalar);
    cv.floodFill(img, mask, new cv.Point(w, 0), scalar);
    cv.floodFill(img, mask, new cv.Point(w, h), scalar);
    cv.floodFill(img, mask, new cv.Point(0, h), scalar);
  } finally {
    mask.delete();
  }
  return img;
}

export function processImage(img, options = undefined) {
  let a;
  try {
    a = trimBottom(img);
  } catch (cause) {
    throw new Error(`Failed to trim bottom: ${cause?.message ?? cause}`, { cause });
  }

  try {
    let b;
    try {
      b = trimRight(a, {
        threshold: options?.trimRightThreshold,
        max: options?.trimRightMax,
      });
    } catch (cause) {
      throw new Error(`Failed to trim right: ${cause?.message ?? cause}`, { cause });
    }

    try {
      let c;
      try {
        c = binarize(b, {
          blockSize: options?.binarizeBlockSize,
          threshold: options?.binarizeThreshold,
        });
      } catch (cause) {
        throw new Error(`Failed to binarize: ${cause?.message ?? cause}`, { cause });
      }

      try {
        fillCorners(c);
      } catch (cause) {
        throw new Error(`Failed to fill corners: ${cause?.message ?? cause}`, { cause });
      }
      return c;
    } finally {
      b.delete();
    }
  } finally {
    a.delete();
  }
}

// packImage takes an opencv image and convert it into a 1-bit packed image for pdf
export function packImage(img) {
  const bytesPerRow = Math.ceil(img.cols / 8);
  const packedBytes = new Uint8Array(bytesPerRow * img.rows);

  for (let byteIndex = 0; byteIndex < packedBytes.length; byteIndex++) {
    const row = Math.floor(byteIndex / bytesPerRow);
    const col = (byteIndex % bytesPerRow) * 8;
    const offset = row * img.cols;
    const range = img.data.subarray(
      offset + col,
      offset + Math.min(col + 8, img.cols),
    );

    packedBytes[byteIndex] =
      (Number(Boolean(range[0])) << 7) |
      (Number(Boolean(range[1])) << 6) |
      (Number(Boolean(range[2])) << 5) |
      (Number(Boolean(range[3])) << 4) |
      (Number(Boolean(range[4])) << 3) |
      (Number(Boolean(range[5])) << 2) |
      (Number(Boolean(range[6])) << 1) |
      Number(Boolean(range[7]));
  }

  return packedBytes;
}
