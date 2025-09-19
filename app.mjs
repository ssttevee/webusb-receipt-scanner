import { wrap } from "https://esm.sh/comlink@4.4.1";
import { connectScanner, scanImages } from "./scanner.mjs";

/* -------------------------------------------------
 * DOM elements
 * ------------------------------------------------- */
const connectBtn = document.getElementById("connectBtn");
const scanBtn = document.getElementById("scanBtn");
const stopBtn = document.getElementById("stopBtn");
const status = document.getElementById("status");
const originalCanvas = document.getElementById("originalCanvas");
const processedCanvas = document.getElementById("processedCanvas");
const pagesList = document.getElementById("pagesList");
const pageCount = document.getElementById("pageCount");
const clearPagesBtn = document.getElementById("clearPagesBtn");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const reprocessBtn = document.getElementById("reprocessBtn");

// Control elements
const binarizeThreshold = document.getElementById("binarizeThreshold");
const binarizeThresholdValue = document.getElementById(
  "binarizeThresholdValue",
);
const binarizeBlockSize = document.getElementById("binarizeBlockSize");
const binarizeBlockSizeValue = document.getElementById(
  "binarizeBlockSizeValue",
);
const trimRightThreshold = document.getElementById("trimRightThreshold");
const trimRightThresholdValue = document.getElementById(
  "trimRightThresholdValue",
);
const trimRightMax = document.getElementById("trimRightMax");
const trimRightMaxValue = document.getElementById("trimRightMaxValue");
const binarizeThresholdReset = document.getElementById(
  "binarizeThresholdReset",
);
const binarizeBlockSizeReset = document.getElementById(
  "binarizeBlockSizeReset",
);
const trimRightThresholdReset = document.getElementById(
  "trimRightThresholdReset",
);
const trimRightMaxReset = document.getElementById("trimRightMaxReset");

/* -------------------------------------------------
 * Status utility
 * ------------------------------------------------- */
function showStatus(message, type = "info") {
  status.textContent = message;
  status.className = `status ${type}`;
  status.classList.remove("hidden");
}

/* -------------------------------------------------
 * Worker management (auto-restart on preview errors)
 * ------------------------------------------------- */
let worker = null;
let workerApi = null;
let workerGeneration = 0;
let restartingWorker = false;

function initWorker() {
  workerGeneration++;
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // ignore
    }
  }
  worker = new Worker("./worker.mjs", { type: "module" });
  workerApi = wrap(worker);
}

async function restartWorker(reason = "unknown") {
  if (restartingWorker) return;
  restartingWorker = true;
  console.warn("Restarting image processing worker. Reason:", reason);
  showStatus("Recovering from processing error... restarting engine", "info");
  initWorker();
  // Allow event loop to tick; OpenCV WASM may need a moment
  await new Promise((r) => setTimeout(r, 10));
  restartingWorker = false;
  showStatus("Processing engine restarted", "success");
}

initWorker();

/* -------------------------------------------------
 * Application state
 * ------------------------------------------------- */
let isConnected = false;
let isScanning = false;
let scanAbortController = null;
let currentImageData = null;
let scannedPages = [];

/* -------------------------------------------------
 * Input synchronization & resets
 * ------------------------------------------------- */
function syncInputs(slider, numberInput) {
  slider.addEventListener("input", () => {
    numberInput.value = slider.value;
    updatePreview();
  });

  numberInput.addEventListener("input", () => {
    slider.value = numberInput.value;
    updatePreview();
  });
}

syncInputs(binarizeThreshold, binarizeThresholdValue);
syncInputs(binarizeBlockSize, binarizeBlockSizeValue);
syncInputs(trimRightThreshold, trimRightThresholdValue);
syncInputs(trimRightMax, trimRightMaxValue);

function addResetHandler(btn, slider, numberInput, defaultValue) {
  btn?.addEventListener("click", () => {
    slider.value = defaultValue;
    numberInput.value = defaultValue;
    updatePreview();
  });
}

addResetHandler(
  binarizeThresholdReset,
  binarizeThreshold,
  binarizeThresholdValue,
  60,
);
addResetHandler(
  binarizeBlockSizeReset,
  binarizeBlockSize,
  binarizeBlockSizeValue,
  199,
);
addResetHandler(
  trimRightThresholdReset,
  trimRightThreshold,
  trimRightThresholdValue,
  0.3,
);
addResetHandler(trimRightMaxReset, trimRightMax, trimRightMaxValue, 1);

/* -------------------------------------------------
 * Processing options
 * ------------------------------------------------- */
function getProcessingOptions() {
  return {
    binarizeThreshold: Number.parseInt(binarizeThresholdValue.value, 10),
    binarizeBlockSize: Number.parseInt(binarizeBlockSizeValue.value, 10),
    trimRightThreshold: Number.parseFloat(trimRightThresholdValue.value),
    trimRightMax: Number.parseFloat(trimRightMaxValue.value),
  };
}

/* -------------------------------------------------
 * Preview (with auto-restart)
 * ------------------------------------------------- */
async function updatePreview(allowRestart = true) {
  if (!currentImageData) return;

  const genAtStart = workerGeneration;
  processedCanvas.parentElement.classList.add("processing");
  try {
    const options = getProcessingOptions();
    const result = await workerApi.processImageData(currentImageData, options);

    // Ignore stale result if worker restarted during call
    if (genAtStart !== workerGeneration) return;

    const processedCtx = processedCanvas.getContext("2d");
    processedCanvas.width = result.width;
    processedCanvas.height = result.height;
    processedCtx.putImageData(result.previewImageData, 0, 0);
  } catch (error) {
    console.error("Preview update failed:", error);
    if (allowRestart) {
      await restartWorker(error?.message || "preview update error");
      try {
        await updatePreview(false);
        return;
      } catch (retryErr) {
        console.error("Preview retry after restart failed:", retryErr);
        showStatus("Preview failed after engine restart", "error");
      }
    } else {
      showStatus("Preview update failed - check console for details", "error");
    }
  } finally {
    processedCanvas.parentElement.classList.remove("processing");
  }
}

/* -------------------------------------------------
 * Scanner connection
 * ------------------------------------------------- */
connectBtn.addEventListener("click", async () => {
  try {
    connectBtn.disabled = true;
    showStatus("Connecting to scanner...", "info");
    await connectScanner();
    isConnected = true;
    connectBtn.textContent = "Connected";
    scanBtn.disabled = false;
    showStatus("Scanner connected successfully", "success");
  } catch (error) {
    console.error("Connection failed:", error);
    showStatus(`Connection failed: ${error.message}`, "error");
    connectBtn.disabled = false;
  }
});

/* -------------------------------------------------
 * Scanning workflow
 * ------------------------------------------------- */
scanBtn.addEventListener("click", async () => {
  if (!isConnected) return;

  try {
    isScanning = true;
    scanBtn.disabled = true;
    stopBtn.disabled = false;
    scanAbortController = new AbortController();

    showStatus(
      "Scanning documents... Place document and scan will start automatically",
      "info",
    );

    let scanCount = 0;
    for await (const imageData of scanImages(scanAbortController.signal)) {
      scanCount++;
      showStatus(`Processing scan ${scanCount}...`, "info");

      const originalCtx = originalCanvas.getContext("2d");
      originalCanvas.width = imageData.width;
      originalCanvas.height = imageData.height;
      originalCtx.putImageData(imageData, 0, 0);

      currentImageData = imageData;

      try {
        await updatePreview(); // preview may trigger a restart
        const options = getProcessingOptions();
        const result = await workerApi.processImageData(imageData, options);

        const pageData = {
          id: Date.now() + Math.random(),
          imageData,
          processedData: {
            data: result.packedData,
            width: result.width,
            height: result.height,
          },
          timestamp: new Date().toLocaleTimeString(),
        };

        scannedPages.push(pageData);
        updatePagesList();

        showStatus(
          `Successfully scanned page ${scannedPages.length}. Ready for next document...`,
          "success",
        );
      } catch (error) {
        console.error("Image processing failed:", error);
        showStatus(
          `Failed to process scan ${scanCount}: ${error.message}`,
          "error",
        );
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("Scanning failed:", error);
      showStatus(`Scanning failed: ${error.message}`, "error");
    } else {
      showStatus("Scanning stopped by user", "info");
    }
  } finally {
    isScanning = false;
    scanBtn.disabled = false;
    stopBtn.disabled = true;
    scanAbortController = null;
    if (scannedPages.length > 0) {
      showStatus(
        `Scanning complete. ${scannedPages.length} page(s) ready for PDF export`,
        "success",
      );
    }
  }
});

stopBtn.addEventListener("click", () => {
  if (scanAbortController) {
    scanAbortController.abort();
    showStatus("Scanning stopped", "info");
  }
});

/* -------------------------------------------------
 * Pages list management
 * ------------------------------------------------- */
function updatePagesList() {
  pageCount.textContent = scannedPages.length;
  downloadPdfBtn.disabled = scannedPages.length === 0;
  reprocessBtn.disabled = scannedPages.length === 0;

  pagesList.innerHTML = "";

  scannedPages.forEach((page, index) => {
    const pageItem = document.createElement("div");
    pageItem.className = "page-item";

    const thumbnail = document.createElement("canvas");
    thumbnail.className = "page-thumbnail";
    thumbnail.width = 50;
    thumbnail.height = 50;

    const thumbCtx = thumbnail.getContext("2d");
    const scale = Math.min(
      50 / page.imageData.width,
      50 / page.imageData.height,
    );
    const width = page.imageData.width * scale;
    const height = page.imageData.height * scale;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = page.imageData.width;
    tempCanvas.height = page.imageData.height;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.putImageData(page.imageData, 0, 0);

    thumbCtx.drawImage(tempCanvas, 0, 0, width, height);

    const pageInfo = document.createElement("div");
    pageInfo.innerHTML = `
      <strong>Page ${index + 1}</strong><br>
      <small>${page.timestamp} - ${page.processedData.width}×${page.processedData.height}</small>
    `;

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.onclick = () => {
      scannedPages.splice(index, 1);
      updatePagesList();
      showStatus(`Removed page ${index + 1}`, "info");
    };

    pageItem.appendChild(thumbnail);
    pageItem.appendChild(pageInfo);
    pageItem.appendChild(removeBtn);

    pagesList.appendChild(pageItem);
  });
}

/* -------------------------------------------------
 * Reprocess all pages
 * ------------------------------------------------- */
reprocessBtn.addEventListener("click", async () => {
  if (scannedPages.length === 0) return;

  try {
    reprocessBtn.disabled = true;
    showStatus(`Reprocessing ${scannedPages.length} page(s)...`, "info");

    const options = getProcessingOptions();
    for (let i = 0; i < scannedPages.length; i++) {
      const page = scannedPages[i];
      showStatus(
        `Reprocessing page ${i + 1}/${scannedPages.length}...`,
        "info",
      );

      const result = await workerApi.processImageData(page.imageData, options);
      page.processedData = {
        data: result.packedData,
        width: result.width,
        height: result.height,
      };
    }

    updatePagesList();
    showStatus(
      `Successfully reprocessed ${scannedPages.length} page(s)`,
      "success",
    );
  } catch (error) {
    console.error("Reprocessing failed:", error);
    showStatus(`Reprocessing failed: ${error.message}`, "error");
  } finally {
    reprocessBtn.disabled = scannedPages.length === 0;
  }
});

/* -------------------------------------------------
 * Clear pages
 * ------------------------------------------------- */
clearPagesBtn.addEventListener("click", () => {
  scannedPages = [];
  updatePagesList();
  showStatus("All pages cleared", "info");
});

/* -------------------------------------------------
 * PDF generation
 * ------------------------------------------------- */
downloadPdfBtn.addEventListener("click", async () => {
  if (scannedPages.length === 0) return;

  try {
    downloadPdfBtn.disabled = true;
    showStatus(`Generating PDF with ${scannedPages.length} page(s)...`, "info");

    const images = scannedPages.map((page) => page.processedData);
    const pdfData = await workerApi.createPDF(images);

    if ("showSaveFilePicker" in window) {
      try {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: `scanned-document-${new Date().toISOString().slice(0, 10)}-${Date.now()}.pdf`,
          types: [
            {
              description: "PDF files",
              accept: { "application/pdf": [".pdf"] },
            },
          ],
        });

        const writable = await fileHandle.createWritable();
        await writable.write(pdfData);
        await writable.close();

        showStatus(
          `PDF saved successfully with ${scannedPages.length} page(s)`,
          "success",
        );
      } catch (error) {
        if (error.name !== "AbortError") {
          throw error;
        } else {
          showStatus("Save cancelled by user", "info");
        }
      }
    } else {
      const blob = new Blob([pdfData], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `scanned-document-${new Date().toISOString().slice(0, 10)}-${Date.now()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);

      showStatus(
        `PDF downloaded with ${scannedPages.length} page(s)`,
        "success",
      );
    }
  } catch (error) {
    console.error("PDF generation failed:", error);
    showStatus(`PDF generation failed: ${error.message}`, "error");
  } finally {
    downloadPdfBtn.disabled = scannedPages.length === 0;
  }
});

/* -------------------------------------------------
 * Keyboard shortcuts
 * ------------------------------------------------- */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) {
    switch (e.key) {
      case "s":
        e.preventDefault();
        if (!scanBtn.disabled) {
          scanBtn.click();
        }
        break;
      case "Enter":
        e.preventDefault();
        if (!downloadPdfBtn.disabled) {
          downloadPdfBtn.click();
        }
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        if (scannedPages.length > 0) {
          clearPagesBtn.click();
        }
        break;
    }
  }

  if (e.key === "Escape" && isScanning) {
    e.preventDefault();
    stopBtn.click();
  }
});

/* -------------------------------------------------
 * Initial status
 * ------------------------------------------------- */
showStatus(
  "Ready to connect scanner (Ctrl+S to scan, Ctrl+Enter to download PDF)",
  "info",
);
