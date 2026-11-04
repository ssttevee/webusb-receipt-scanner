import { printedDate, receiptDimensions, sampleZip, seededRandom, validateLabels } from "./sample-input-utils.mjs";
import { createRawScanner, rawPreview } from "./raw-scanner.mjs";

const $ = (id) => document.getElementById(id);
const labelIds = ["date", "time", "labelState", "groupId", "pageOrder", "split", "tags", "sourceDpi", "notes"];
let current = null;
let previewUrl = null;
let stripUrl = null;
let busy = false;
let scanner = null;
let saneModule = null;
let scanController = null;
let releaseOwnership = null;
let diagnosticIds = [];

function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.error = String(error);
}

function controls() {
  $("save").disabled = busy || !current;
  $("export").disabled = busy || !current;
  $("saveDisk").disabled = busy || !current;
  $("connectScanner").disabled = busy || Boolean(scanner?.connected());
  $("startCapture").disabled = busy || !scanner?.connected();
  $("disconnectScanner").disabled = busy || !scanner?.connected();
  $("inspectScanner").disabled = busy || !scanner?.connected();
  $("stopCapture").disabled = !scanController || scanController.signal.aborted;
  $("deleteSample").disabled = busy || !$("saved").value;
  $("deleteDiagnostics").disabled = busy || diagnosticIds.length === 0;
  for (const id of ["stripRow", "showStrip", "nextStrip", "lastStrip"]) $(id).disabled = busy;
  for (const id of ["longPaper", "scanLength", "scanDpi", "autoDisk", "generate", "sourceFile", "load", "saved", "seed", "widthMm", "lengthMm", "fixtureDpi", "dateFormat", "ink", "noise", ...labelIds, "languages", "unprocessed", "physicalComplete"]) $(id).disabled = busy;
}

async function action(callback) {
  if (busy) return;
  busy = true;
  controls();
  try { await callback(); }
  catch (error) {
    if (error.configuration) $("sessionFailure").textContent = JSON.stringify(error.configuration, null, 2);
    status(error.message || String(error), true);
  }
  finally { busy = false; controls(); }
}

function labels() {
  const date = $("date").value.trim();
  const time = $("time").value.trim();
  validateLabels(date, time);
  const order = Number($("pageOrder").value);
  const dpi = $("sourceDpi").value ? Number($("sourceDpi").value) : null;
  if (!Number.isInteger(order) || order < 1 || order > 1000) throw new Error("Page order must be 1–1,000.");
  if (dpi !== null && (!Number.isInteger(dpi) || dpi < 1 || dpi > 2400)) throw new Error("Source DPI must be 1–2,400 or blank.");
  return {
    date: date || null, time: time || null, state: $("labelState").value,
    group_id: $("groupId").value.trim() || null, page_order: order,
    split: $("split").value, tags: $("tags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
    source_dpi_annotation: dpi, notes: $("notes").value,
    languages: Array.from($("languages").selectedOptions, (option) => option.value),
    physical_bottom_confirmed: $("physicalComplete").checked,
  };
}

async function setInput(input) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  current = input;
  if (stripUrl) URL.revokeObjectURL(stripUrl);
  stripUrl = null;
  $("stripPreview").hidden = true;
  $("stripPreview").removeAttribute("src");
  $("stripControls").hidden = !input.scanner || !(input.dimensions?.height > 0);
  $("stripRow").value = "0";
  $("preview").hidden = true;
  $("preview").onload = null;
  $("preview").onerror = null;
  $("diagnostics").textContent = input.scanner ? JSON.stringify(input.scanner, null, 2) : "No scanner diagnostics for this input.";
  const preview = input.preview || (input.extension === "png" ? input.blob : null);
  previewUrl = preview ? URL.createObjectURL(preview) : null;
  if (preview) {
    $("preview").onload = () => {
      if (current?.id !== input.id) return;
      if (!input.scanner) input.dimensions = { width: $("preview").naturalWidth, height: $("preview").naturalHeight };
      $("details").textContent = `${input.id} · ${input.kind} · ${input.dimensions.width} × ${input.dimensions.height} pixels · ${(input.blob.size / 1048576).toFixed(2)} MiB`;
    };
    $("preview").onerror = () => status("Preview failed. The original bytes remain available for export.", true);
    $("preview").src = previewUrl;
    $("preview").hidden = false;
  } else {
    $("preview").removeAttribute("src");
  }
  $("details").textContent = `${input.id} · ${input.kind} · ${(input.blob.size / 1048576).toFixed(2)} MiB${input.extension === "tiff" ? " · TIFF preview unavailable; bytes retained" : ""}`;
}

const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("receipt-sample-inputs", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("samples", { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => status("Close another sample-input tab to finish opening storage.", true);
});

// Handle an unavailable database immediately; generation/export can still work.
database.catch((error) => status(`Browser storage unavailable: ${error.message}. ZIP export remains available.`, true));

async function store(mode, callback) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("samples", mode);
    const request = callback(transaction.objectStore("samples"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error("Browser storage transaction aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("Browser storage failed."));
  });
}

async function refreshSaved() {
  // Cursor values include blobs, but are not decoded or converted to image buffers.
  const db = await database;
  const options = await new Promise((resolve, reject) => {
    const transaction = db.transaction("samples", "readonly");
    const result = [];
    const request = transaction.objectStore("samples").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const item = cursor.value;
      result.push({ id: item.id, diagnostic: item.kind === "scanner-diagnostic" && item.blob.size === 0,
        text: `${item.id.slice(0, 8)} · ${item.manifest.labels.date || "unresolved"} · ${item.kind} · ${item.manifest.labels.split}` });
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error);
  });
  diagnosticIds = options.filter((item) => item.diagnostic).map((item) => item.id);
  $("saved").replaceChildren(new Option("Choose a saved sample", ""), ...options.map((item) => new Option(item.text, item.id)));
  if (current) $("saved").value = current.id;
  controls();
}

function clearCurrent() {
  current = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (stripUrl) URL.revokeObjectURL(stripUrl);
  previewUrl = stripUrl = null;
  for (const id of ["preview", "stripPreview"]) {
    $(id).onload = $(id).onerror = null;
    $(id).removeAttribute("src");
    $(id).hidden = true;
  }
  $("stripControls").hidden = true;
  $("details").textContent = "No input selected.";
  $("diagnostics").textContent = "No capture selected.";
  resetLabels();
}

async function deleteSamples(ids) {
  let deleted = 0;
  const failures = [];
  for (const id of ids) {
    try {
      // Keep the browser record until the workstation acknowledges deletion.
      const response = await fetch(`/api/samples/${id}`, { method: "DELETE" });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        throw new Error(`Workstation deletion was not acknowledged (HTTP ${response.status}). Restart sample-server.py if it has not been updated.`);
      }
      const result = await response.json();
      if (result.id !== id || result.deleted !== true || result.durable !== true) {
        throw new Error("Workstation deletion acknowledgment does not match the selected sample.");
      }
      await store("readwrite", (collection) => collection.delete(id));
      if (current?.id === id) clearCurrent();
      deleted++;
    } catch (error) { failures.push(error.message || String(error)); }
  }
  await refreshSaved();
  status(`Deleted ${deleted} sample(s) from this browser and the workstation sample folder.${failures.length ? ` ${failures.length} could not be fully removed; browser entries retained for retry. ${failures[0]}` : ""}`, failures.length > 0);
}

$("saved").addEventListener("change", controls);
$("deleteSample").addEventListener("click", () => action(async () => {
  const id = $("saved").value;
  if (!id) throw new Error("Choose a saved sample first.");
  await deleteSamples([id]);
}));
$("deleteDiagnostics").addEventListener("click", () => action(async () => {
  await deleteSamples([...diagnosticIds]);
}));

async function manifest(input = current, expected = labels(), unprocessed = $("unprocessed").checked) {
  if (!isSecureContext || !crypto.subtle) throw new Error("Use HTTPS or localhost to compute checksums.");
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    bytes,
    value: {
      schema_version: 1, id: input.id, created_at: input.createdAt, labelled_at: new Date().toISOString(),
      source: {
        kind: input.kind, original_filename: input.originalName || null,
        artifact: `original.${input.extension}`, sha256, byte_length: bytes.length,
        dimensions: input.dimensions || null, unprocessed_annotation: input.kind === "synthetic" ? null : unprocessed,
        generator: input.generator || null, browser: navigator.userAgent,
        scanner: input.scanner || null,
      },
      labels: expected,
      synthetic_ground_truth: input.groundTruth || null,
      completeness: "not_verified_against_physical_receipt",
    },
  };
}

function resetLabels() {
  for (const id of ["date", "time", "groupId", "sourceDpi", "tags", "notes"]) $(id).value = "";
  $("labelState").value = "unlabelled";
  $("pageOrder").value = "1";
  $("unprocessed").checked = false;
  $("physicalComplete").checked = false;
  for (const option of $("languages").options) option.selected = false;
}

async function saveLocal(input = current, result = null) {
  result ||= await manifest(input);
  const saved = { ...input, manifest: result.value };
  await store("readwrite", (collection) => collection.put(saved));
  if (current?.id === input.id) current = saved;
  await refreshSaved();
  return result;
}

async function bundle(result, input = current) {
  const entries = [
    { name: result.value.source.artifact, bytes: result.bytes },
    { name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(result.value, null, 2) + "\n") },
  ];
  if (input.preview) entries.push({ name: "preview.png", bytes: new Uint8Array(await input.preview.arrayBuffer()) });
  return sampleZip(entries);
}

async function saveDisk(result, input = current) {
  const response = await fetch(`/api/samples/${input.id}`, {
    method: "PUT", headers: { "Content-Type": "application/zip" }, body: await bundle(result, input),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`Workstation save was not acknowledged (HTTP ${response.status}). Browser copy retained; retry Save to workstation folder.`);
  }
  const saved = await response.json();
  if (saved.id !== input.id || saved.sha256 !== result.value.source.sha256 || saved.durable !== true) {
    throw new Error("Workstation save acknowledgment does not match the capture.");
  }
}

async function claimScanner() {
  if (!navigator.locks) throw new Error("This browser cannot coordinate scanner ownership. Use desktop Chrome/Edge.");
  await new Promise((resolve, reject) => {
    navigator.locks.request("receipt-sample-scanner", { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error("Another sample tab owns the scanner. Disconnect it first.")); return; }
      await new Promise((release) => { releaseOwnership = release; resolve(); });
    }).catch(reject);
  });
}

$("connectScanner").addEventListener("click", () => action(async () => {
  if (!isSecureContext || !navigator.usb || !crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw new Error("Scanning requires Chrome/Edge, localhost, WebUSB, and isolation headers. Run python3 sample-server.py.");
  }
  if (typeof globalThis.LibSANE !== "function") throw new Error("Scanner assets missing. Run npm install, then python3 sample-server.py.");
  // Permission must start within the user's click, before dependency loading.
  const usbDevice = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x04b8 }] });
  await claimScanner();
  try {
    status("Loading the local scanner driver…");
    if (!saneModule) {
      const module = await globalThis.LibSANE({ locateFile: (path) => new URL(`./scanner-assets/${path}`, location.href).href });
      const init = module.sane_init();
      if (init.status !== 0) throw new Error(`Initialize scanner: ${module.sane_strstatus(init.status)}`);
      const provenance = await fetch("/scanner-assets/provenance.json");
      if (provenance.ok) module.RECEIPT_DRIVER_PROVENANCE = await provenance.json();
      saneModule = module;
    }
    const candidate = createRawScanner(saneModule, { usb: { vendor_id: usbDevice.vendorId, product_id: usbDevice.productId,
      product_name: usbDevice.productName || null, manufacturer_name: usbDevice.manufacturerName || null } });
    const device = await candidate.connect();
    scanner = candidate;
    const snapshot = await scanner.inspect();
    $("diagnostics").textContent = JSON.stringify(snapshot, null, 2);
    const longSupported = snapshot.options.some((option) => option.name === "long-paper" && !option.cap?.INACTIVE);
    const driverVersion = snapshot.library.provenance?.patch_revision || snapshot.library.version;
    $("scannerStatus").textContent = `${device.vendor} ${device.model} (${device.name}); driver ${driverVersion}. Long-paper option: ${longSupported ? "available" : "unavailable"}.`;
    status("Scanner ready. Start a session and feed receipts.");
  } catch (error) {
    if (!scanner?.connected()) {
      releaseOwnership?.();
      releaseOwnership = null;
    }
    throw error;
  }
}));

$("inspectScanner").addEventListener("click", () => action(async () => {
  const snapshot = await scanner.inspect();
  $("diagnostics").textContent = JSON.stringify(snapshot, null, 2);
  status("Current driver options shown in diagnostics; no settings changed.");
}));

$("stopCapture").addEventListener("click", () => {
  scanController?.abort();
  controls();
  status("Stop requested. Waiting for the current driver operation; partial bytes will be retained.");
});

$("disconnectScanner").addEventListener("click", () => action(async () => {
  await scanner.disconnect();
  releaseOwnership?.();
  releaseOwnership = null;
  status("Scanner disconnected.");
  $("scannerStatus").textContent = "Scanner disconnected.";
}));

async function retainCapture(capture) {
  const diagnostics = capture.scanner.diagnostics;
  const focus = diagnostics.transport_complete || !current?.blob.size;
  const input = { id: crypto.randomUUID(), createdAt: diagnostics.started_at,
    kind: capture.blob.size ? "scanner-raw" : "scanner-diagnostic",
    extension: "bin", blob: capture.blob, dimensions: capture.dimensions, scanner: capture.scanner };
  const resolution = capture.scanner.resolution.y;
  const expected = { date: null, time: null, state: "unlabelled", group_id: null, page_order: 1,
    split: $("split").value, tags: diagnostics.transport_complete ? [] :
      (diagnostics.jam_reported ? ["incomplete", "feeder-jam"] : ["incomplete"]),
    source_dpi_annotation: Number.isInteger(resolution) && resolution > 0 && resolution <= 2400 ? resolution : null,
    notes: "", languages: [], physical_bottom_confirmed: false };
  if (focus) {
    resetLabels();
    $("unprocessed").checked = capture.blob.size > 0;
    $("sourceDpi").value = expected.source_dpi_annotation ?? "";
    $("tags").value = expected.tags.join(", ");
    await setInput(input);
  }
  // Retain full-resolution raw data before generating any display preview.
  const result = await manifest(input, expected, capture.blob.size > 0);
  await saveLocal(input, result);
  if ($("autoDisk").checked) await saveDisk(result, input);
  if (!diagnostics.transport_complete) {
    $("sessionFailure").textContent = JSON.stringify({ sample_id: input.id, displayed_sample_id: current?.id,
      scanner: input.scanner }, null, 2);
  }
  // No pixels means no display preview to create. This also avoids redundant saves.
  if (!input.blob.size) return input;
  try {
    input.preview = await rawPreview(input.blob, input.scanner.parameters);
  } catch (error) {
    if (focus) $("diagnostics").textContent += `\nPreview unavailable: ${error.message}. Original retained.`;
    return input;
  }
  if (focus) await setInput(input);
  await saveLocal(input, result);
  if ($("autoDisk").checked) await saveDisk(result, input);
  return input;
}

$("startCapture").addEventListener("click", () => action(async () => {
  scanController = new AbortController();
  controls();
  let count = 0;
  try {
    status("Applying the selected scanner profile…");
    const snapshot = await scanner.configure({ longPaper: $("longPaper").checked,
      maxLengthMm: Number($("scanLength").value), resolution: $("scanDpi").value ? Number($("scanDpi").value) : null });
    if (!current) $("diagnostics").textContent = JSON.stringify(snapshot, null, 2);
    while (!scanController.signal.aborted) {
      status(`Waiting for receipt ${count + 1}… No idle cutoff.`);
      let capture;
      try {
        capture = await scanner.capture({ signal: scanController.signal, onPhase: (phase) => {
          if (phase === "parameters") status(`Acquiring receipt ${count + 1} in the driver; rows are not available yet…`);
        }, onProgress: ({ rows, byteLength }) => {
          status(`Reading receipt ${count + 1}: ${rows.toLocaleString()} rows, ${(byteLength / 1048576).toFixed(1)} MiB.`);
        } });
      } catch (error) {
        if (error.capture) {
          const saved = await retainCapture(error.capture);
          const diagnostics = error.capture.scanner.diagnostics;
          error.message += ` Failed attempt ${saved.id.slice(0, 8)} saved (${error.capture.blob.size ? "partial image" : "diagnostics only; no image bytes returned"}).`;
          if (current?.id !== saved.id) error.message += ` Receipt ${current.id.slice(0, 8)} remains displayed.`;
          if (diagnostics.jam_reported && !$("longPaper").checked) {
            error.message += " For a receipt over 508 mm, reconnect and enable Long receipt before retrying.";
          }
        }
        if (scanController.signal.aborted && !error.capture) break;
        throw error;
      }
      if (!capture) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      await retainCapture(capture);
      count++;
    }
    status(`Session stopped. ${count} transport-complete raw capture(s) saved. Select saved samples to label/export.`);
  } finally { scanController = null; }
}));

async function showStrip() {
  if (!current?.scanner) throw new Error("Select a raw scanner sample first.");
  const row = Number($("stripRow").value);
  const preview = await rawPreview(current.blob, current.scanner.parameters, { maxWidth: 16384, maxHeight: 512, rowStart: row, rowCount: 512 });
  if (!preview) throw new Error("This row range/frame format has no supported display pixels. Original bytes remain retained.");
  if (stripUrl) URL.revokeObjectURL(stripUrl);
  stripUrl = URL.createObjectURL(preview);
  $("stripPreview").src = stripUrl;
  $("stripPreview").hidden = false;
  status(`Showing full-resolution rows ${row}–${Math.min(row + 511, current.dimensions.height - 1)}. Original unchanged.`);
}

$("showStrip").addEventListener("click", () => action(showStrip));
$("nextStrip").addEventListener("click", () => action(async () => {
  $("stripRow").value = String(Math.min(Number($("stripRow").value) + 512, Math.max(0, current.dimensions.height - 1)));
  await showStrip();
}));
$("lastStrip").addEventListener("click", () => action(async () => {
  $("stripRow").value = String(Math.max(0, current.dimensions.height - 512));
  await showStrip();
}));

$("sourceFile").addEventListener("change", () => action(async () => {
  const file = $("sourceFile").files[0];
  if (!file) return;
  if (file.size > 100 * 1048576) throw new Error("Sample import is limited to 100 MiB per file.");
  const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const png = prefix.length === 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => prefix[i] === byte);
  const tiff = (prefix[0] === 73 && prefix[1] === 73 && [42, 43].includes(prefix[2]) && prefix[3] === 0) ||
    (prefix[0] === 77 && prefix[1] === 77 && prefix[2] === 0 && [42, 43].includes(prefix[3]));
  if (!png && !tiff) throw new Error("Input must have a PNG or TIFF file signature.");
  await setInput({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), kind: "real-import", extension: png ? "png" : "tiff", originalName: file.name, blob: file });
  resetLabels();
  status("Imported bytes unchanged. Enter expected labels, then save or download.");
}));

$("generate").addEventListener("click", () => action(async () => {
  const expected = labels();
  const widthMm = Number($("widthMm").value);
  const lengthMm = Number($("lengthMm").value);
  const dpi = Number($("fixtureDpi").value);
  const { width, height } = receiptDimensions(widthMm, lengthMm, dpi);
  const seed = Number($("seed").value);
  const ink = Number($("ink").value);
  const noise = Number($("noise").value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(ink) || ink < 5 || ink > 100 ||
      !Number.isInteger(noise) || noise < 0 || noise > 100000) throw new Error("Check seed, ink strength, and noise limits.");
  status("Generating synthetic input…");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Browser could not allocate the fixture canvas.");
  try {
    const random = seededRandom(seed);
    ctx.fillStyle = "#faf8ef";
    ctx.fillRect(0, 0, width, height);
    const fontSize = Math.max(12, Math.round(2.4 * dpi / 25.4));
    const margin = Math.round(4 * dpi / 25.4);
    const lineHeight = Math.round(fontSize * 1.7);
    ctx.font = `${fontSize}px monospace`;
    ctx.textBaseline = "top";
    ctx.fillStyle = `rgb(${Math.round(255 * (1 - ink / 100))} ${Math.round(255 * (1 - ink / 100))} ${Math.round(255 * (1 - ink / 100))})`;
    const line = (text, y) => ctx.fillText(text, margin, y);
    let y = margin;
    for (const text of ["SYNTHETIC TEST RECEIPT", `START seed=${seed}`, printedDate(expected.date, $("dateFormat").value), expected.time || "TIME NOT PRINTED", "------------------------"]) {
      line(text, y);
      y += lineHeight;
    }
    let item = 1;
    while (y < height - 3 * lineHeight - margin) {
      line(`Test row ${String(item++).padStart(4, "0")}    ${(random() * 90 + 1).toFixed(2)}`, y);
      y += lineHeight;
    }
    line(`END seed=${seed}`, height - lineHeight - margin);
    for (let i = 0; i < noise; i++) {
      ctx.fillStyle = `rgba(40,40,40,${(random() * .15).toFixed(3)})`;
      ctx.fillRect(Math.floor(random() * width), Math.floor(random() * height), 1 + Math.floor(random() * 3), 1);
    }
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed; reduce fixture dimensions.")), "image/png"));
    await setInput({
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), kind: "synthetic", extension: "png", blob,
      dimensions: { width, height }, groundTruth: { date: expected.date, time: expected.time },
      generator: { version: 1, seed, width_mm: widthMm, length_mm: lengthMm, dpi, ink_percent: ink, noise_dots: noise, date_format: $("dateFormat").value, font: ctx.font },
    });
    $("sourceDpi").value = String(dpi);
    $("unprocessed").checked = false;
    $("physicalComplete").checked = false;
    status("Synthetic input generated. Printed ground truth is saved separately from later edits to labels.");
  } finally {
    canvas.width = canvas.height = 0;
  }
}));

$("save").addEventListener("click", () => action(async () => {
  status("Saving original and manifest in browser storage…");
  await saveLocal();
  status("Original and labels saved in this browser. Download the ZIP for durable sample collection outside browser storage.");
}));

$("saveDisk").addEventListener("click", () => action(async () => {
  status("Saving sample to workstation folder…");
  const result = await saveLocal();
  await saveDisk(result);
  status("Sample durably saved to workstation folder and retained in this browser.");
}));

$("export").addEventListener("click", () => action(async () => {
  status("Building original + manifest ZIP…");
  const result = await manifest();
  const zip = await bundle(result);
  const url = URL.createObjectURL(zip);
  const link = document.createElement("a");
  link.href = url;
  link.download = `sample-${current.id}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  status("Sample ZIP download requested. The original bytes have not been processed.");
}));

$("load").addEventListener("click", () => action(async () => {
  if (!$("saved").value) throw new Error("Choose a saved sample first.");
  const item = await store("readonly", (collection) => collection.get($("saved").value));
  if (!item) throw new Error("Saved sample no longer exists in browser storage.");
  await setInput(item);
  const expected = item.manifest.labels;
  const values = {
    date: expected.date, time: expected.time, labelState: expected.state, groupId: expected.group_id,
    pageOrder: expected.page_order, split: expected.split, tags: expected.tags.join(", "),
    sourceDpi: expected.source_dpi_annotation, notes: expected.notes,
  };
  for (const [id, value] of Object.entries(values)) $(id).value = value ?? "";
  $("unprocessed").checked = Boolean(item.manifest.source.unprocessed_annotation);
  $("physicalComplete").checked = Boolean(expected.physical_bottom_confirmed);
  for (const option of $("languages").options) option.selected = (expected.languages || []).includes(option.value);
  status("Loaded saved original and labels.");
}));

refreshSaved().catch((error) => status(`Cannot list browser samples: ${error.message}. Generation and ZIP export remain available.`, true));
