import * as signals from "https://esm.sh/@preact/signals";
import * as Comlink from "https://esm.sh/comlink@4.4.1";
import {
  formatDateForFilename,
  initOCR,
  parseDateTime,
  recognizeText,
} from "./ocr.mjs";
import getScanner from "./scanner.mjs";

const { batch, computed, effect, signal } = signals;

export async function initApp(options) {
  const scanner = await getScanner(options?.sane);

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
  const expectedYear = document.getElementById("expectedYear");
  const expectedMonth = document.getElementById("expectedMonth");
  const selectionOverlay = document.getElementById("selectionOverlay");
  const selectionBox = document.getElementById("selectionBox");

  // Control elements
  function setupControlSignal(sliderId) {
    const slider = document.getElementById(sliderId);
    const textBox = document.getElementById(`${sliderId}Value`);
    const resetButton = document.getElementById(`${sliderId}Reset`);

    const defaultValue = Number.parseFloat(slider.value);
    const minValue = Number.parseFloat(slider.min);
    const maxValue = Number.parseFloat(slider.max);

    textBox.value = slider.value;
    textBox.max = slider.min;
    textBox.min = slider.max;

    const sig = signal(defaultValue);

    slider.addEventListener("input", () => {
      sig.value = Number.parseFloat(slider.value);
    });

    textBox.addEventListener("input", () => {
      sig.value = Number.parseFloat(textBox.value);
    });

    resetButton.addEventListener("click", () => {
      sig.value = defaultValue;
    });

    effect(() => {
      const newValue = sig.value;
      const parsedValue = Number.parseFloat(newValue);
      if (parsedValue < minValue) {
        sig.value = minValue;
        return;
      }

      if (parsedValue > maxValue) {
        sig.value = maxValue;
        return;
      }

      slider.value = newValue;
      textBox.value = newValue;
    });

    return sig;
  }

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
  let restartingWorker = false;

  let imageDataRegistry = new WeakMap();

  async function initWorker() {
    if (worker) {
      try {
        workerApi[Comlink.releaseProxy]();
        worker.terminate();
      } catch {
        // ignore
      }
      imageDataRegistry = new WeakMap();
    }

    const temp = new Worker(new URL("./worker.mjs", import.meta.url), {
      type: "module",
    });
    await new Promise((resolve) => Comlink.expose({ onready: resolve }, temp));

    worker = temp;
    workerApi = Comlink.wrap(worker);
  }

  async function restartWorker(reason = "unknown") {
    if (restartingWorker) return;
    restartingWorker = true;
    console.warn("Restarting image processing worker. Reason:", reason);
    showStatus("Recovering from processing error... restarting engine", "info");
    await initWorker();
    // Allow event loop to tick; OpenCV WASM may need a moment
    await new Promise((r) => setTimeout(r, 10));
    restartingWorker = false;
    showStatus("Processing engine restarted", "success");
  }

  initWorker();

  /* -------------------------------------------------
   * Application state
   * ------------------------------------------------- */

  const binarizeThreshold = setupControlSignal("binarizeThreshold");
  const binarizeBlockSize = setupControlSignal("binarizeBlockSize");
  const trimRightThreshold = setupControlSignal("trimRightThreshold");
  const trimRightMax = setupControlSignal("trimRightMax");

  const connectionState = signal(
    scanner.connected() ? "CONNECTED" : "DISCONNECTED",
  ); // or "CONNECTING" or "CONNECTED"
  const scanAbortController = signal(null);
  const pages = signal([]);
  const currentPageIndex = signal(-1);
  const currentPage = computed(() => pages.value[currentPageIndex.value]);

  const previewInFlight = signal(false);

  const autoSaveFolderHandle = signal(null);
  const detectedDate = signal(null);
  const dateSelection = signal(null);

  const isConnected = computed(() => connectionState.value === "CONNECTED");
  const isScanning = computed(() => Boolean(scanAbortController.value));

  const processingOptions = computed(() => ({
    binarizeThreshold: binarizeThreshold.value,
    binarizeBlockSize: binarizeBlockSize.value,
    trimRightThreshold: trimRightThreshold.value,
    trimRightMax: trimRightMax.value,
  }));

  const defaultProcessingOptions = processingOptions.value;

  const context = {
    elements: {
      connectBtn,
      scanBtn,
      stopBtn,
      status,
      originalCanvas,
      processedCanvas,
      pagesList,
      pageCount,
      clearPagesBtn,
      downloadPdfBtn,
      expectedYear,
      expectedMonth,
      selectionOverlay,
      selectionBox,
    },
    state: {
      binarizeThreshold,
      binarizeBlockSize,
      trimRightThreshold,
      trimRightMax,
      connectionState,
      scanAbortController,
      pages,
      currentPageIndex,
      currentPage,
      previewInFlight,
      autoSaveFolderHandle,
      detectedDate,
      dateSelection,
      isConnected,
      isScanning,
      processingOptions,
    },
    showStatus,
  };

  /* -------------------------------------------------
   * OCR Date Detection
   * ------------------------------------------------- */

  initOCR();

  expectedYear.value = new Date().getFullYear();
  expectedMonth.value = new Date().getMonth() + 1;

  effect(() => {
    selectionOverlay.style.display = dateSelection.value ? "block" : "none";
  });

  processedCanvas.addEventListener("mousedown", (e) => {
    const rect = processedCanvas.getBoundingClientRect();
    const scaleX = processedCanvas.width / rect.width;
    const scaleY = processedCanvas.height / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    dateSelection.value = { x, y, width: 0, height: 0 };
  });

  processedCanvas.addEventListener("mousemove", (e) => {
    if (!dateSelection.value) return;

    const startX = dateSelection.value.x;
    const startY = dateSelection.value.y;

    const rect = processedCanvas.getBoundingClientRect();
    const scaleX = processedCanvas.width / rect.width;
    const scaleY = processedCanvas.height / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const minX = Math.min(startX, x);
    const minY = Math.min(startY, y);
    const width = Math.abs(x - startX);
    const height = Math.abs(y - startY);

    dateSelection.value = { x: minX, y: minY, width: width, height: height };

    const displayRect = processedCanvas.getBoundingClientRect();
    const displayScaleX = displayRect.width / processedCanvas.width;
    const displayScaleY = displayRect.height / processedCanvas.height;

    selectionOverlay.setAttribute("width", displayRect.width);
    selectionOverlay.setAttribute("height", displayRect.height);
    selectionBox.setAttribute("x", minX * displayScaleX);
    selectionBox.setAttribute("y", minY * displayScaleY);
    selectionBox.setAttribute("width", width * displayScaleX);
    selectionBox.setAttribute("height", height * displayScaleY);
  });

  processedCanvas.addEventListener("mouseup", async () => {
    if (!dateSelection.value) return;

    const { x: minX, y: minY, width, height } = dateSelection.value;

    dateSelection.value = null;

    if (width < 10 || height < 10) {
      showStatus("Selection too small, please try again", "error");
      return;
    }

    try {
      showStatus("Reading date from selection...", "info");

      const page = currentPage.value;
      const imageData = page.previewImageData || page.originalImageData;

      const canvas = document.createElement("canvas");
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      const ctx = canvas.getContext("2d");
      ctx.putImageData(imageData, 0, 0);

      const croppedCanvas = document.createElement("canvas");
      croppedCanvas.width = width;
      croppedCanvas.height = height;
      const croppedCtx = croppedCanvas.getContext("2d");
      croppedCtx.drawImage(
        canvas,
        minX,
        minY,
        width,
        height,
        0,
        0,
        width,
        height,
      );

      const croppedImageData = croppedCtx.getImageData(0, 0, width, height);

      const text = await recognizeText(croppedImageData);
      console.log("OCR Result:", text);

      const year = expectedYear.value ? parseInt(expectedYear.value, 10) : null;
      const month = expectedMonth.value
        ? parseInt(expectedMonth.value, 10)
        : null;

      const parsedDate = parseDateTime(text, year, month);
      if (parsedDate) {
        detectedDate.value = parsedDate;

        showStatus(
          `Date detected: ${formatDateForFilename(parsedDate)}`,
          "success",
        );
      } else {
        showStatus("Could not detect a valid date from the selection", "error");
      }
    } catch (error) {
      console.error("OCR failed:", error);
      showStatus(`OCR failed: ${error.message}`, "error");
    }
  });

  /* -------------------------------------------------
   * Preview
   * ------------------------------------------------- */

  effect(() => {
    if (previewInFlight.value) {
      processedCanvas.parentElement.classList.add("processing");
    } else {
      processedCanvas.parentElement.classList.remove("processing");
    }
  });

  effect(() => {
    const originalCtx = originalCanvas.getContext("2d");
    const processedCtx = processedCanvas.getContext("2d");

    const page = currentPage.value;
    if (!page) {
      originalCanvas.width = processedCanvas.width = 400;
      originalCanvas.height = processedCanvas.height = 300;
      originalCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height);
      processedCtx.clearRect(
        0,
        0,
        processedCanvas.width,
        processedCanvas.height,
      );
      return;
    }

    const { originalImageData, previewImageData } = page;

    originalCanvas.width = originalImageData.width;
    originalCanvas.height = originalImageData.height;
    originalCtx.putImageData(originalImageData, 0, 0);

    if (previewImageData) {
      processedCanvas.width = previewImageData.width;
      processedCanvas.height = previewImageData.height;
      processedCtx.putImageData(previewImageData, 0, 0);
    } else {
      processedCtx.clearRect(
        0,
        0,
        processedCanvas.width,
        processedCanvas.height,
      );
    }
  });

  effect(() => {
    const page = pages.peek()[currentPageIndex.value];

    let options;
    if (!page) {
      options = defaultProcessingOptions;
    } else {
      ({ options } = page);
    }

    batch(() => {
      binarizeThreshold.value = options.binarizeThreshold;
      binarizeBlockSize.value = options.binarizeBlockSize;
      trimRightThreshold.value = options.trimRightThreshold;
      trimRightMax.value = options.trimRightMax;
    });
  });

  effect(() => {
    let newOptions = processingOptions.value;
    let newPage = currentPageIndex.value;
    if (previewInFlight.peek()) return;

    previewInFlight.value = true;

    (async () => {
      let currentOptions = {};
      let currentPage = -1;
      while (
        (JSON.stringify(currentOptions) !== JSON.stringify(newOptions) ||
          currentPage !== newPage) &&
        pages.value[newPage]
      ) {
        try {
          const result = await processImageDataWithRetry(
            pages.value[newPage].originalImageData,
            newOptions,
          );

          const cachedPages = pages.value;
          if (cachedPages.length > newPage) {
            pages.value = [
              ...cachedPages.slice(0, newPage),
              {
                ...cachedPages[newPage],
                options: newOptions,
                previewImageData: result.previewImageData,
                packedImage: result.packedData,
              },
              ...cachedPages.slice(newPage + 1),
            ];
          }
        } catch (error) {
          console.error("Preview update failed:", error);
          showStatus(
            "Preview update failed - check console for details",
            "error",
          );
          break;
        }

        currentOptions = newOptions;
        newOptions = processingOptions.value;

        currentPage = newPage;
        newPage = currentPageIndex.value;
      }
    })().finally(() => {
      previewInFlight.value = false;
    });
  });

  async function processImageData(imageData, options) {
    let imageId = imageDataRegistry.get(imageData);
    if (!imageId) {
      imageId = await workerApi.registerImage(imageData);
      imageDataRegistry.set(imageData, imageId);
    }

    return await workerApi.processImageData(imageId, options);
  }

  async function processImageDataWithRetry(imageData, options) {
    try {
      return await processImageData(imageData, options);
    } catch (error) {
      await restartWorker(error);
    }

    console.log("retrying image processing after restarting worker");
    try {
      const result = await processImageData(imageData, options);
      console.log("retried result");
      return result;
    } catch (error) {
      console.error("Retry failed:", error);
      throw error;
    }
  }

  /* -------------------------------------------------
   * Scanner connection
   * ------------------------------------------------- */

  effect(() => {
    switch (connectionState.value) {
      case "DISCONNECTED":
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect Scanner";
        scanBtn.disabled = true;
        break;
      case "CONNECTING":
        connectBtn.disabled = true;
        connectBtn.textContent = "Connecting";
        scanBtn.disabled = true;
        scanner.connect().then(
          () => {
            connectionState.value = "CONNECTED";
            showStatus("Scanner connected successfully", "success");
          },
          (error) => {
            connectionState.value = "DISCONNECTED";
            console.error("Connection failed:", error);
            showStatus(`Connection failed: ${error.message}`, "error");
          },
        );
        break;
      case "CONNECTED":
        connectBtn.disabled = true;
        connectBtn.textContent = "Connected";
        scanBtn.disabled = false;
        scanAbortController.value = new AbortController();
    }
  });

  connectBtn.addEventListener("click", async () => {
    connectionState.value = "CONNECTING";
  });

  /* -------------------------------------------------
   * Scanning workflow
   * ------------------------------------------------- */

  effect(() => {
    if (isScanning.value) {
      scanBtn.disabled = true;
      stopBtn.disabled = false;
    } else {
      scanBtn.disabled = !isConnected.value;
      stopBtn.disabled = true;
    }
  });

  effect(() => {
    const ctlr = scanAbortController.value;
    if (!ctlr) return;

    showStatus(
      "Waiting for documents... Place document and scan will start automatically",
      "info",
    );

    let timeoutId;

    function updateTimeout() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => ctlr.abort("Scanning timed out"), 30000);
    }

    const abortSignal = ctlr.signal;

    (async () => {
      updateTimeout();
      for await (const imageData of scanner.scanImages(abortSignal)) {
        batch(() => {
          pages.value = [
            ...pages.value,
            { originalImageData: imageData, options: defaultProcessingOptions },
          ];
          currentPageIndex.value = pages.value.length - 1;
        });

        updateTimeout();
      }
    })()
      .catch((error) => {
        if (abortSignal.aborted) {
          showStatus(abortSignal.reason, "info");
        } else {
          console.error("Scanning failed:", error);
          showStatus(`Scanning failed: ${error.message}`, "error");
        }
      })
      .finally(() => {
        scanAbortController.value = null;

        if (pages.value.length) {
          showStatus(
            `Scanning complete. ${pages.value.length} page(s) ready for PDF export`,
            "success",
          );
        }
      });
  });

  scanBtn.addEventListener("click", async () => {
    if (!isConnected.value || isScanning.value) return;
    scanAbortController.value = new AbortController();
  });

  stopBtn.addEventListener("click", () => {
    if (scanAbortController.value) {
      scanAbortController.value.abort("Scanning stopped by user");
    }
  });

  /* -------------------------------------------------
   * Pages list management
   * ------------------------------------------------- */

  effect(() => {
    const scannedPages = pages.value;
    pageCount.textContent = scannedPages.length;
    downloadPdfBtn.disabled = scannedPages.length === 0;

    pagesList.innerHTML = "";
    for (const [index, page] of scannedPages.entries()) {
      const pageItem = document.createElement("div");
      pageItem.className = "page-item";
      pageItem.addEventListener("click", () => {
        currentPageIndex.value = index;
      });

      const thumbnail = document.createElement("canvas");
      thumbnail.className = "page-thumbnail";
      thumbnail.width = 50;
      thumbnail.height = 50;

      const thumbCtx = thumbnail.getContext("2d");
      const imageData = page.previewImageData ?? page.originalImageData;
      const scale = Math.min(50 / imageData.width, 50 / imageData.height);
      const width = imageData.width * scale;
      const height = imageData.height * scale;

      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = imageData.width;
      tempCanvas.height = imageData.height;
      const tempCtx = tempCanvas.getContext("2d");
      tempCtx.putImageData(imageData, 0, 0);

      thumbCtx.drawImage(tempCanvas, 0, 0, width, height);

      const pageInfo = document.createElement("div");
      pageInfo.innerHTML = `
        <strong>Page ${index + 1}</strong><br>
        <small>${imageData.width}×${imageData.height}</small>
      `;

      const buttons = document.createElement("div");
      buttons.className = "button-group";

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
      });

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        batch(() => {
          const cachedPages = pages.value;
          pages.value = [
            ...cachedPages.slice(0, index),
            ...cachedPages.slice(index + 1),
          ];
          currentPageIndex.value -= 1;
        });
      });

      buttons.appendChild(saveBtn);
      buttons.appendChild(removeBtn);

      pageItem.appendChild(thumbnail);
      pageItem.appendChild(pageInfo);
      pageItem.appendChild(buttons);

      pagesList.appendChild(pageItem);
    }
  });

  /* -------------------------------------------------
   * Clear pages
   * ------------------------------------------------- */
  clearPagesBtn.addEventListener("click", () => {
    batch(() => {
      pages.value = [];
      currentPageIndex.value = -1;
    });
    detectedDate.value = null;
    selectionOverlay.style.display = "none";
    showStatus("All pages cleared", "info");
  });

  /* -------------------------------------------------
   * PDF generation
   * ------------------------------------------------- */

  downloadPdfBtn.addEventListener("click", async () => {
    if (pages.value.length === 0) return;

    try {
      downloadPdfBtn.disabled = true;
      await (options?.onComplete ?? defaultOnCompleteBehaviour)(context);
    } catch (error) {
      console.error("PDF generation failed:", error);
      showStatus(`PDF generation failed: ${error.message}`, "error");
    } finally {
      downloadPdfBtn.disabled = pages.value.length === 0;
    }
  });

  effect(() => {
    if (!detectedDate.value) {
      return;
    }

    downloadFilename.value = formatDateForFilename(detectedDate.value);
  });

  /* -------------------------------------------------
   * Initial status
   * ------------------------------------------------- */

  if (!isConnected.value) {
    showStatus("Ready to connect scanner", "info");
  }
}

export { create1BitImagePDF } from "./pdf.mjs";
export { signals };
