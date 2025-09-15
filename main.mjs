import { cv, packImage, processImage } from "./imgproc.mjs";
import { create1BitImagePDF } from "./pdf.mjs";
import { connectScanner, scanImages } from "./scanner.mjs";

async function img2pdf(img) {
  const pdfString = await create1BitImagePDF([
    { data: packImage(img), width: img.cols, height: img.rows },
  ]);
  return new Blob([pdfString], { type: "application/pdf" });
}

await connectScanner();

for await (const img of scanImages()) {
  const canvas = new OffscreenCanvas("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = img.width;
  canvas.height = img.height;
  console.log("Image size:", canvas.width, canvas.height);
  ctx.putImageData(img, 0, 0);

  const im = cv.imread(canvas);
  const out = processImage(im);
  try {
    const url = URL.createObjectURL(await img2pdf(out));

    // Create download link
    const a = document.createElement("a");
    a.href = url;
    a.download = `${Date.now()}.pdf`;
    a.click();

    URL.revokeObjectURL(url);
  } finally {
    out.delete();
    im.delete();
  }
}
