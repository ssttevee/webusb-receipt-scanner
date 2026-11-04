// Raw SANE capture is independent of image processing and dependency loading.
// The status/frame constants are part of the SANE API (sane-wasm 0.5.0).
const GOOD = 0;
const CANCELLED = 2;
const DEVICE_BUSY = 3;
const EOF = 5;
const NO_DOCS = 7;
const JAMMED = 6;

export function createRawScanner(sane, { maxBytes = 256 * 1048576, maxPixels = 160000000, usb = null } = {}) {
  let device = null;
  let active = false;
  let recoveryNeeded = false;
  let configuration = null;

  function check(result, operation) {
    if (result.status !== GOOD) {
      const error = new Error(`${operation}: ${sane.sane_strstatus(result.status)}`);
      error.saneStatus = result.status;
      error.operation = operation;
      throw error;
    }
    return result;
  }

  async function connect() {
    if (active) throw new Error("A scanner operation is already running.");
    if (device) return device;
    active = true;
    try {
      const result = check(await sane.sane_get_devices(), "Discover scanner");
      for (const candidate of result.devices || []) {
        const opened = await sane.sane_open(candidate.name);
        if (opened.status === GOOD) {
          device = { ...candidate, usb };
          recoveryNeeded = false;
          return device;
        }
      }
      throw new Error("No permitted scanner could be opened. Close other scanner applications and reconnect.");
    } finally { active = false; }
  }

  async function settings() {
    const values = [];
    for (let index = 0; index < 512; index++) {
      const { status, option_descriptor: descriptor } = sane.sane_get_option_descriptor(index);
      if (status !== GOOD || !descriptor) break;
      if (descriptor.type === 4 || descriptor.type === 5) continue;
      if (descriptor.cap?.INACTIVE || !descriptor.cap?.SOFT_DETECT) {
        values.push({ index, name: descriptor.name, title: descriptor.title, unit: descriptor.unit, type: descriptor.type,
          cap: descriptor.cap, constraint: descriptor.constraint, value: null, status: null });
        continue;
      }
      const result = await sane.sane_control_option_get_value(index);
      values.push({ index, name: descriptor.name, title: descriptor.title, unit: descriptor.unit, type: descriptor.type,
        value: result.status === GOOD ? result.value : null, status: result.status, constraint: descriptor.constraint, cap: descriptor.cap });
    }
    return values;
  }

  function identity() {
    return { device, library: { version: sane.SANE_WASM_VERSION || null, commit: sane.SANE_WASM_COMMIT || null,
      backends: sane.SANE_WASM_BACKENDS || null, provenance: sane.RECEIPT_DRIVER_PROVENANCE || null,
      sane: sane.sane_get_state().version }, configuration };
  }

  async function inspect() {
    if (!device || active) throw new Error("Connect the scanner and stop capture before reading settings.");
    active = true;
    try { return { ...identity(), options: await settings() }; }
    finally { active = false; }
  }

  async function configure({ longPaper = false, maxLengthMm = 1200, resolution = null } = {}) {
    if (!device || active || recoveryNeeded) throw new Error("Connect a ready scanner and stop capture before changing settings.");
    if (typeof longPaper !== "boolean" || (longPaper && (!Number.isFinite(maxLengthMm) || maxLengthMm < 508 || maxLengthMm > 1200)) ||
        (resolution !== null && (!Number.isInteger(resolution) || resolution < 1 || resolution > 600))) {
      throw new Error("Invalid long-paper height or scanner resolution.");
    }
    active = true;
    const changes = [];
    const before = await settings().catch((error) => { active = false; throw error; });
    configuration = { long_paper_requested: longPaper, max_length_mm: longPaper ? maxLengthMm : null,
      resolution_requested: resolution, before, changes, applied: false };
    const find = (name) => {
      for (let index = 0; index < 512; index++) {
        const { status, option_descriptor: descriptor } = sane.sane_get_option_descriptor(index);
        if (status !== GOOD || !descriptor) break;
        if (descriptor.name === name) return { index, descriptor };
      }
      return null;
    };
    const write = async (name, value) => {
      const option = find(name);
      if (!option || option.descriptor.cap?.INACTIVE || !option.descriptor.cap?.SOFT_SELECT) {
        throw new Error(`The driver does not expose a writable ${name} option. Check the selected driver build and scanner capabilities.`);
      }
      const previous = check(await sane.sane_control_option_get_value(option.index), `Read ${name}`).value;
      const result = check(await sane.sane_control_option_set_value(option.index, value), `Set ${name}`);
      // Option indexes/constraints may change after RELOAD_OPTIONS.
      const refreshed = find(name);
      if (!refreshed) throw new Error(`Driver removed ${name} after applying it.`);
      const actual = check(await sane.sane_control_option_get_value(refreshed.index), `Verify ${name}`).value;
      changes.push({ name, before: previous, requested: value, after: actual, info: result.info });
      if (typeof value === "boolean" ? Boolean(actual) !== value : Math.abs(actual - value) > 0.001) {
        throw new Error(`Driver constrained ${name} to ${actual}; requested ${value}. Scanning has not started.`);
      }
    };
    try {
      const longOption = find("long-paper");
      if (longPaper && (!longOption || longOption.descriptor.cap?.INACTIVE)) {
        throw new Error("Long paper is unavailable in this driver/device. Use the patched epsonds build; its scanner-advertised maximum must exceed the normal height.");
      }
      // Disable the previous long profile before changing DPI; the backend
      // correctly rejects resolutions above 300 while long mode is enabled.
      if (longOption && !longOption.descriptor.cap?.INACTIVE) {
        const value = check(await sane.sane_control_option_get_value(longOption.index), "Read long-paper").value;
        if (value) await write("long-paper", false);
      }
      if (resolution !== null) await write("resolution", resolution);
      if (longPaper) {
        const dpi = find("resolution");
        const actual = dpi && check(await sane.sane_control_option_get_value(dpi.index), "Read resolution").value;
        if (!Number.isFinite(actual) || actual > 300) throw new Error("Long paper requires a known resolution at or below 300 DPI. Select 200 or 300 DPI explicitly.");
        await write("long-paper", true);
        const height = find("br-y");
        if (!height || height.descriptor.unit !== 3 || !Number.isFinite(height.descriptor.constraint?.max)) {
          throw new Error("Driver did not expose a bounded long-paper height in millimeters.");
        }
        if (height.descriptor.constraint.max < maxLengthMm) {
          throw new Error(`Scanner advertises only ${height.descriptor.constraint.max.toFixed(1)} mm. Lower the requested maximum; no scan has started.`);
        }
        await write("br-y", maxLengthMm);
      }
      configuration.applied = true;
      return { ...identity(), options: await settings() };
    } catch (error) {
      configuration.error = error.message;
      error.configuration = configuration;
      throw error;
    } finally { active = false; }
  }

  async function capture({ signal, onProgress = () => {}, onPhase = () => {} } = {}) {
    if (!device) throw new Error("Connect a scanner first.");
    if (recoveryNeeded) throw new Error("The driver needs recovery. Disconnect and reconnect before scanning again.");
    if (active) throw new Error("A scanner operation is already running.");
    active = true;
    const chunks = [];
    const startedAt = new Date().toISOString();
    let parameters = null;
    let options = [];
    let byteLength = 0;
    let readCalls = 0;
    let endStatus = null;
    let startStatus = null;
    let parameterStatus = null;
    let cancelStatus = null;
    let phase = "settings";
    let startAttempted = false;
    let failure = null;
    let noDocument = false;
    const cancelled = () => {
      if (signal?.aborted) {
        const error = new Error("Capture stopped; received bytes are retained as an incomplete sample.");
        error.userCancelled = true;
        throw error;
      }
    };
    try {
      cancelled();
      options = await settings();
      cancelled();
      phase = "start";
      onPhase(phase);
      startAttempted = true;
      const start = await sane.sane_start();
      startStatus = start.status;
      if ([NO_DOCS, DEVICE_BUSY].includes(start.status)) {
        noDocument = true;
        onPhase(start.status === DEVICE_BUSY ? "busy" : "idle");
      }
      else {
        check(start, "Start scan");
        cancelled();
        phase = "parameters";
        onPhase(phase);
        const result = await sane.sane_get_parameters();
        parameterStatus = result.status;
        parameters = { ...check(result, "Read scan parameters").parameters };
        const { bytes_per_line: stride, pixels_per_line: width, lines, depth, format } = parameters;
        if (!Number.isInteger(stride) || stride <= 0 || !Number.isInteger(width) || width <= 0 || width > 16384 ||
            !Number.isInteger(lines) || lines < -1 || ![1, 8, 16].includes(depth) || ![0, 1, 2, 3, 4].includes(format)) {
          throw new Error("Invalid or unsupported scanner frame parameters.");
        }
        const channels = format === 1 ? 3 : 1;
        if (stride < Math.ceil(width * channels * depth / 8)) throw new Error("Scanner row stride is shorter than its pixel data.");
        if (lines > 0 && (lines * stride > maxBytes || lines * width > maxPixels)) throw new Error("Reported scan dimensions exceed the raw capture limits.");
        while (true) {
          phase = "read";
          cancelled();
          const result = await sane.sane_read();
          readCalls++;
          endStatus = result.status;
          if (result.data?.length) {
            if (byteLength + result.data.length > maxBytes || Math.ceil((byteLength + result.data.length) / stride) * width > maxPixels) {
              throw new Error("Raw capture exceeded its byte/pixel limit; retained bytes are incomplete.");
            }
            // Copy immediately: returned data may be a view into mutable WASM memory.
            const copy = new Uint8Array(result.data);
            chunks.push(copy);
            byteLength += copy.length;
            onProgress({ byteLength, rows: Math.floor(byteLength / stride), parameters });
          }
          cancelled();
          if (result.status === EOF) break;
          check(result, "Read scanner data");
          // Keep the UI responsive even if a backend resolves immediately.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (!byteLength) throw new Error("Scanner returned EOF without image data.");
        if (byteLength % stride) throw new Error("Scanner returned a partial final row; capture is incomplete.");
        if (lines > 0 && byteLength / stride !== lines) throw new Error("Received row count differs from the scanner's reported height.");
        if (!parameters.last_frame) throw new Error("Additional color frames are required; only the incomplete first frame has been retained.");
      }
    } catch (error) { failure = error; failure.phase = phase; }
    finally {
      // Cooperative Stop: never race a cancel/close call against an outstanding
      // WASM call. A pending call must return before cancellation can run.
      // An empty/busy feeder did not accept a scan. Do not cancel another
      // device job or create a pending cancel marker for ordinary polling.
      if (startAttempted && !noDocument) {
        try {
          const result = await sane.sane_cancel();
          cancelStatus = result.status;
          if (![GOOD, CANCELLED].includes(result.status)) {
            const error = new Error(`Cancel scan: ${sane.sane_strstatus(result.status)}`);
            error.saneStatus = result.status;
            error.operation = "Cancel scan";
            throw error;
          }
        } catch (error) {
          recoveryNeeded = true;
          if (!failure) { failure = error; failure.phase = "cancel"; }
        }
      }
      active = false;
    }
    if (noDocument && !failure) return null;
    const resolution = (name) => options.find((option) => option.name === name)?.value ?? null;
    const capture = {
      blob: new Blob(chunks, { type: "application/octet-stream" }),
      dimensions: parameters?.bytes_per_line > 0 ? { width: parameters.pixels_per_line, height: Math.floor(byteLength / parameters.bytes_per_line) } : null,
      scanner: {
        ...identity(),
        parameters, options, resolution: { x: resolution("x-resolution") ?? resolution("resolution"), y: resolution("y-resolution") ?? resolution("resolution") },
        diagnostics: { started_at: startedAt, finished_at: new Date().toISOString(), byte_length: byteLength, read_calls: readCalls,
          start_status: startStatus, parameter_status: parameterStatus, end_status: endStatus, cancel_status: cancelStatus,
          failure_phase: failure?.phase || null, failure_operation: failure?.operation || null,
          failure_status: failure?.saneStatus ?? null,
          jam_reported: [startStatus, parameterStatus, endStatus].includes(JAMMED),
          eof_received: endStatus === EOF, transport_complete: !failure,
          physical_completeness: "not_verified", recovery_needed: recoveryNeeded, error: failure?.message || null },
      },
    };
    if (failure) {
      // epsonds may acquire the entire image inside get_parameters and discard
      // its internal buffer on a jam. Retain diagnostic-only attempts as well.
      const quietStop = signal?.aborted && (failure.userCancelled || failure.saneStatus === CANCELLED) &&
        byteLength === 0 && !recoveryNeeded;
      failure.capture = !quietStop && (byteLength || startAttempted) ? capture : null;
      throw failure;
    }
    return capture;
  }

  async function disconnect() {
    if (active) throw new Error("Wait for the current device operation to finish before disconnecting.");
    active = true;
    try {
      if (device) check(await sane.sane_close(), "Close scanner");
      device = null;
      recoveryNeeded = false;
    } finally { active = false; }
  }

  return { connect, capture, configure, inspect, disconnect, connected: () => Boolean(device) };
}

// Display-only downsampled preview. Full-resolution bytes and row padding stay
// unchanged in original.bin. No full-height RGBA canvas is allocated.
export async function rawPreview(blob, parameters, { maxWidth = 800, maxHeight = 1600, rowStart = 0, rowCount = null } = {}) {
  if (!parameters || ![0, 1].includes(parameters.format) || ![1, 8, 16].includes(parameters.depth) ||
      (parameters.format === 1 && parameters.depth === 1)) return null;
  const available = Math.floor(blob.size / parameters.bytes_per_line);
  if (!Number.isInteger(rowStart) || rowStart < 0 || (rowCount !== null && (!Number.isInteger(rowCount) || rowCount < 1))) {
    throw new Error("Invalid preview row range.");
  }
  const end = Math.min(available, rowStart + (rowCount ?? available));
  const rows = Math.max(0, end - rowStart);
  if (!rows) return null;
  const bytes = new Uint8Array(await blob.slice(rowStart * parameters.bytes_per_line, end * parameters.bytes_per_line).arrayBuffer());
  const scale = Math.min(1, maxWidth / parameters.pixels_per_line, maxHeight / rows);
  const width = Math.max(1, Math.floor(parameters.pixels_per_line * scale));
  const height = Math.max(1, Math.floor(rows * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not allocate a preview canvas.");
    const image = context.createImageData(width, height);
    const channels = parameters.format === 1 ? 3 : 1;
    const view = new DataView(bytes.buffer);
    for (let y = 0; y < height; y++) {
      const row = Math.floor(y * (rows - 1) / Math.max(1, height - 1)) * parameters.bytes_per_line;
      for (let x = 0; x < width; x++) {
        const source = Math.floor(x * (parameters.pixels_per_line - 1) / Math.max(1, width - 1));
        const target = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const sample = source * channels + (channels === 1 ? 0 : channel);
          let value;
          if (parameters.depth === 8) value = bytes[row + sample];
          else if (parameters.depth === 16) value = view.getUint16(row + sample * 2, true) >>> 8; // WASM is little-endian.
          else value = (bytes[row + (sample >>> 3)] & (0x80 >>> (sample & 7))) ? 0 : 255;
          image.data[target + channel] = value;
        }
        image.data[target + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally { canvas.width = canvas.height = 0; }
}
