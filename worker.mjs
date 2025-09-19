import { expose } from "https://esm.sh/comlink@4.4.1";
import { cv, processImage, packImage } from "./imgproc.mjs";
import { create1BitImagePDF } from "./pdf.mjs";

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

const api = {
  async processImageData(imageData, options = {}) {
    // Convert to OpenCV Mat
    const im = new cv.matFromImageData(imageData);

    try {
      // Process the image with the given options
      const processed = processImage(im, options);

      try {
        // Convert processed image back to ImageData for preview
        // For binary images, we need to convert single channel to RGBA

        // Pack the image for PDF
        const packedData = packImage(processed);

        return {
          previewImageData: matToImageData(processed),
          packedData,
          width: processed.cols,
          height: processed.rows,
        };
      } finally {
        processed.delete();
      }
    } finally {
      im.delete();
    }
  },

  async createPDF(images) {
    return await create1BitImagePDF(images);
  },
};

expose(api);
