import * as Comlink from "https://esm.sh/comlink@4.4.1";
import { cv, processImage, packImage } from "./imgproc.mjs";

function matToImageData(mat) {
  // Ensure the mat is in RGBA format
  let rgbaMat = new cv.Mat();

  // Convert to RGBA if needed
  if (mat.channels() === 1) {
    cv.cvtColor(mat, rgbaMat, cv.COLOR_GRAY2RGBA);
  } else if (mat.channels() === 3) {
    cv.cvtColor(mat, rgbaMat, cv.COLOR_RGB2RGBA);
  } else if (mat.channels() === 4) {
    rgbaMat = mat.clone();
  }

  // Get the raw data
  const data = new Uint8ClampedArray(rgbaMat.data);

  // Create ImageData
  const imageData = new ImageData(data, mat.cols, mat.rows);

  // Clean up
  rgbaMat.delete();

  return imageData;
}

const registeredImages = {};

const api = {
  registerImage(imageData) {
    const id = crypto.randomUUID();
    registeredImages[id] = new cv.matFromImageData(imageData);
    return id;
  },
  deleteImage(imageId) {
    registeredImages[imageId]?.delete();
    delete registeredImages[imageId];
  },
  async processImageData(imageId, options = {}) {
    // Convert to OpenCV Mat
    const im = registeredImages[imageId];
    if (!im) throw new Error(`Image ${imageId} not found`);

    // Process the image with the given options
    let processed;
    try {
      processed = processImage(im, options);
    } catch (error) {
      console.log(typeof error);
      throw new Error(`Failed to process image: ${error.message}`, { cause: error });
    }

    try {
      // Convert processed image back to ImageData for preview
      // For binary images, we need to convert single channel to RGBA

      // Pack the image for PDF
      const packedData = packImage(processed);

      return {
        previewImageData: matToImageData(processed),
        packedData,
      };
    } catch (error) {
      throw new Error(`Failed to pack image: ${error.message}`, { cause: error });
    } finally {
      processed.delete();
    }
  },
};

Comlink.expose(api);

const callbackApi = Comlink.wrap(globalThis);
callbackApi.onready();
callbackApi[Comlink.releaseProxy]();
