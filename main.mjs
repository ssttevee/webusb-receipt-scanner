import { cv, packImage, processImage } from "./imgproc.mjs";
import { create1BitImagePDF } from "./pdf.mjs";
import { connectScanner, scanImages } from "./scanner.mjs";

async function img2pdf(img) {
  const pdfString = await create1BitImagePDF([
    { data: packImage(img), width: img.cols, height: img.rows },
  ]);
  return new Blob([pdfString], { type: "application/pdf" });
}

// await connectScanner();

// for await (const img of scanImages()) {
//   const canvas = new OffscreenCanvas("canvas");
//   const ctx = canvas.getContext("2d");
//   canvas.width = img.width;
//   canvas.height = img.height;
//   console.log("Image size:", canvas.width, canvas.height);
//   ctx.putImageData(img, 0, 0);

//   const im = cv.imread(canvas);
//   const out = processImage(im);
//   try {
//     const url = URL.createObjectURL(await img2pdf(out));

//     // Create download link
//     const a = document.createElement("a");
//     a.href = url;
//     a.download = `${Date.now()}.pdf`;
//     a.click();

//     URL.revokeObjectURL(url);
//   } finally {
//     out.delete();
//     im.delete();
//   }
// }

const image = await new Promise((resolve) => {
  const image = new Image();
  image.onload = () => {
    resolve(image);
  };

  image.src = "/scan.png";
});

const ocanvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
const ctx = ocanvas.getContext("2d");
ctx.drawImage(image, 0, 0);
const imageData = ctx.getImageData(
  0,
  0,
  image.naturalWidth,
  image.naturalHeight,
);

const im = new cv.matFromImageData(imageData);
console.log(imageData.data, im.data);

// const out = processImage(im);
// im.delete();

const canvas = document.createElement("canvas");
canvas.width = im.cols;
canvas.height = im.rows;
cv.imshow(canvas, im);
document.body.appendChild(canvas);

// const url = URL.createObjectURL(await img2pdf(out));

// // Create download link
// const a = document.createElement("a");
// a.href = url;
// a.download = "image.pdf";
// a.click();

// URL.revokeObjectURL(url);

// out.delete();
