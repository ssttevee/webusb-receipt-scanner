import assert from "node:assert/strict";
import test from "node:test";
import { createRawScanner } from "../raw-scanner.mjs";

function backend({ lines = -1, reads = [{ status: 0, data: Uint8Array.of(1, 2, 3, 4) }, { status: 5 }], start = 0, lastFrame = true, cancel = 0 } = {}) {
  const calls = [];
  let index = 0;
  return {
    calls,
    SANE_WASM_VERSION: "test", SANE_WASM_COMMIT: "fixture",
    sane_strstatus: (status) => `status ${status}`,
    sane_get_state: () => ({ version: { major: 1, minor: 0, build: 0 } }),
    sane_get_devices: async () => ({ status: 0, devices: [{ name: "epsonds:test", vendor: "Epson", model: "test" }] }),
    sane_open: async () => { calls.push("open"); return { status: 0 }; },
    sane_close: async () => { calls.push("close"); return { status: 0 }; },
    sane_get_option_descriptor: (option) => ({ status: 0, option_descriptor: option === 0 ? {
      name: "resolution", title: "Resolution", type: 1, unit: 4, cap: { SOFT_DETECT: true }, constraint: [150, 300],
    } : null }),
    sane_control_option_get_value: async () => ({ status: 0, value: 150 }),
    sane_start: async () => { calls.push("start"); return { status: start }; },
    sane_get_parameters: async () => ({ status: 0, parameters: { format: 0, last_frame: lastFrame, bytes_per_line: 2, pixels_per_line: 2, lines, depth: 8 } }),
    sane_read: async () => { calls.push("read"); const value = reads[index++]; return typeof value === "function" ? value() : value; },
    sane_cancel: async () => { calls.push("cancel"); return { status: cancel }; },
  };
}

test("unknown-height capture preserves all bytes and records actual default DPI", async () => {
  const sane = backend();
  const scanner = createRawScanner(sane);
  await scanner.connect();
  const capture = await scanner.capture();
  assert.deepEqual(Array.from(new Uint8Array(await capture.blob.arrayBuffer())), [1, 2, 3, 4]);
  assert.deepEqual(capture.dimensions, { width: 2, height: 2 });
  assert.equal(capture.scanner.resolution.y, 150);
  assert.equal(capture.scanner.diagnostics.transport_complete, true);
  assert.equal(capture.scanner.diagnostics.physical_completeness, "not_verified");
  assert.equal(capture.scanner.parameters.lines, -1);
  assert.deepEqual(sane.calls, ["open", "start", "read", "read", "cancel"]);
});

test("copies mutable WASM views immediately and includes bytes returned with EOF", async () => {
  const memory = Uint8Array.of(1, 2);
  const sane = backend({ reads: [() => ({ status: 0, data: memory }), () => { memory.set([3, 4]); return { status: 5, data: memory }; }] });
  const scanner = createRawScanner(sane);
  await scanner.connect();
  const capture = await scanner.capture();
  assert.deepEqual(Array.from(new Uint8Array(await capture.blob.arrayBuffer())), [1, 2, 3, 4]);
});

test("partial rows, height mismatches, and multi-frame scans retain incomplete originals", async () => {
  for (const options of [
    { reads: [{ status: 5, data: Uint8Array.of(1, 2, 3) }] },
    { lines: 3 },
    { lastFrame: false },
  ]) {
    const scanner = createRawScanner(backend(options));
    await scanner.connect();
    await assert.rejects(scanner.capture(), (error) => {
      assert.ok(error.capture.blob.size > 0);
      assert.equal(error.capture.scanner.diagnostics.transport_complete, false);
      return true;
    });
  }
});

test("byte limits stop a stream and retain preceding data", async () => {
  const scanner = createRawScanner(backend({ reads: [
    { status: 0, data: Uint8Array.of(1, 2) }, { status: 0, data: Uint8Array.of(3, 4) },
  ] }), { maxBytes: 3 });
  await scanner.connect();
  await assert.rejects(scanner.capture(), (error) => {
    assert.match(error.message, /byte\/pixel limit/);
    assert.equal(error.capture.blob.size, 2);
    return true;
  });
});

test("Stop waits for a pending read; no overlapping cancel/close or second capture", async () => {
  let release;
  let reading;
  const reachedRead = new Promise((resolve) => { reading = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const sane = backend({ reads: [() => { reading(); return pending; }] });
  const scanner = createRawScanner(sane);
  await scanner.connect();
  const controller = new AbortController();
  const capturing = scanner.capture({ signal: controller.signal });
  await reachedRead;
  controller.abort();
  await assert.rejects(scanner.capture(), /already running/);
  await assert.rejects(scanner.disconnect(), /current device operation/);
  assert.ok(!sane.calls.includes("cancel"));
  release({ status: 0, data: Uint8Array.of(9, 10) });
  await assert.rejects(capturing, (error) => {
    assert.equal(error.capture.blob.size, 2);
    assert.equal(error.capture.scanner.diagnostics.transport_complete, false);
    return true;
  });
  assert.equal(sane.calls.at(-1), "cancel");
  await scanner.disconnect();
  assert.equal(scanner.connected(), false);
});

test("pre-aborted capture does not start scanner operations", async () => {
  const sane = backend();
  const scanner = createRawScanner(sane);
  await scanner.connect();
  await assert.rejects(scanner.capture({ signal: AbortSignal.abort() }), /Capture stopped/);
  assert.deepEqual(sane.calls, ["open"]);
});

test("empty feeder is idle, a jam is surfaced, and neither starts a silent retry loop", async () => {
  const emptyBackend = backend({ start: 7 });
  const empty = createRawScanner(emptyBackend);
  await empty.connect();
  assert.equal(await empty.capture(), null);
  assert.ok(!emptyBackend.calls.includes("cancel"));
  const jam = createRawScanner(backend({ start: 6 }));
  await jam.connect();
  await assert.rejects(jam.capture(), /Start scan: status 6/);
});

test("start busy is an idle retry, without canceling another job or creating a sample", async () => {
  const sane = backend({ start: 3 });
  const scanner = createRawScanner(sane);
  await scanner.connect();
  assert.equal(await scanner.capture(), null);
  assert.deepEqual(sane.calls, ["open", "start"]);
});

test("Stop before pixels creates no diagnostic, while a real jam after Stop is still retained", async () => {
  for (const status of [0, 6]) {
    let resolveParameters;
    let reached;
    const waiting = new Promise((resolve) => { reached = resolve; });
    const pending = new Promise((resolve) => { resolveParameters = resolve; });
    const sane = backend();
    sane.sane_get_parameters = () => { reached(); return pending; };
    const scanner = createRawScanner(sane);
    await scanner.connect();
    const controller = new AbortController();
    const capturing = scanner.capture({ signal: controller.signal });
    await waiting;
    controller.abort();
    resolveParameters({ status, parameters: status === 0 ? {
      format: 0, last_frame: true, bytes_per_line: 2, pixels_per_line: 2, lines: -1, depth: 8,
    } : null });
    await assert.rejects(capturing, (error) => {
      if (status === 0) assert.equal(error.capture, null);
      else assert.equal(error.capture.scanner.diagnostics.jam_reported, true);
      return true;
    });
    assert.ok(sane.calls.includes("cancel"));
  }
});

test("failed driver cancellation requires disconnect/reconnect", async () => {
  const scanner = createRawScanner(backend({ cancel: 9 }));
  await scanner.connect();
  await assert.rejects(scanner.capture(), (error) => {
    assert.equal(error.capture.scanner.diagnostics.recovery_needed, true);
    return true;
  });
  await assert.rejects(scanner.capture(), /needs recovery/);
  await scanner.disconnect();
});

test("jam during get_parameters preserves a diagnostic attempt even without image bytes", async () => {
  const sane = backend();
  sane.sane_get_parameters = async () => ({ status: 6, parameters: null });
  const scanner = createRawScanner(sane);
  await scanner.connect();
  await assert.rejects(scanner.capture(), (error) => {
    assert.equal(error.capture.blob.size, 0);
    assert.equal(error.capture.dimensions, null);
    assert.equal(error.capture.scanner.diagnostics.failure_phase, "parameters");
    assert.equal(error.capture.scanner.diagnostics.parameter_status, 6);
    assert.equal(error.capture.scanner.diagnostics.failure_status, 6);
    assert.equal(error.capture.scanner.diagnostics.jam_reported, true);
    assert.equal(error.capture.scanner.diagnostics.transport_complete, false);
    assert.equal(error.capture.scanner.options[0].value, 150);
    return true;
  });
  assert.ok(sane.calls.includes("cancel"));
});

test("jam during reading preserves previously returned pixels and its operation", async () => {
  const sane = backend({ reads: [{ status: 0, data: Uint8Array.of(1, 2) }, { status: 6 }] });
  const scanner = createRawScanner(sane);
  await scanner.connect();
  await assert.rejects(scanner.capture(), (error) => {
    assert.equal(error.capture.blob.size, 2);
    assert.equal(error.capture.scanner.diagnostics.failure_operation, "Read scanner data");
    assert.equal(error.capture.scanner.diagnostics.end_status, 6);
    assert.equal(error.capture.scanner.diagnostics.jam_reported, true);
    return true;
  });
});

function configurableBackend({ dpi = 200, max = 1828.8, longSupported = true, constrainHeight = false } = {}) {
  const sane = backend();
  const state = { resolution: dpi, "long-paper": false, "br-y": 508 };
  const descriptors = [
    { name: "resolution", type: 1, unit: 4, constraint: [200, 300, 600] },
    { name: "long-paper", type: 0, unit: 0, cap: { INACTIVE: !longSupported } },
    { name: "br-y", type: 2, unit: 3 },
  ];
  sane.sane_get_option_descriptor = (index) => {
    const descriptor = descriptors[index];
    return { status: 0, option_descriptor: descriptor ? { ...descriptor,
      cap: { SOFT_SELECT: true, SOFT_DETECT: true, ...descriptor.cap },
      constraint: descriptor.name === "br-y" ? { min: 0, max: state["long-paper"] ? max : 508, quant: 0 } : descriptor.constraint,
    } : null };
  };
  sane.sane_control_option_get_value = async (index) => ({ status: 0, value: state[descriptors[index].name] });
  sane.sane_control_option_set_value = async (index, value) => {
    const name = descriptors[index].name;
    sane.calls.push(`set ${name}=${value}`);
    state[name] = name === "br-y" && constrainHeight ? 508 : value;
    return { status: 0, info: { RELOAD_OPTIONS: name === "long-paper", RELOAD_PARAMS: true } };
  };
  return sane;
}

test("long profile verifies read-back constraints, preserves default DPI, and records changes", async () => {
  const sane = configurableBackend();
  const scanner = createRawScanner(sane);
  await scanner.connect();
  const snapshot = await scanner.configure({ longPaper: true, maxLengthMm: 1200 });
  assert.equal(snapshot.options.find((x) => x.name === "resolution").value, 200);
  assert.equal(snapshot.options.find((x) => x.name === "br-y").value, 1200);
  assert.deepEqual(snapshot.configuration.changes.map((x) => x.name), ["long-paper", "br-y"]);
  assert.equal(snapshot.configuration.applied, true);
  assert.ok(!sane.calls.includes("start"));
  await scanner.configure({ longPaper: false });
  assert.equal((await scanner.inspect()).options.find((x) => x.name === "long-paper").value, false);
});

test("unsupported long mode, high DPI, short limits, and silently constrained values never start scanning", async () => {
  for (const options of [{ longSupported: false }, { dpi: 600 }, { max: 600 }, { constrainHeight: true }]) {
    const sane = configurableBackend(options);
    const scanner = createRawScanner(sane);
    await scanner.connect();
    await assert.rejects(scanner.configure({ longPaper: true, maxLengthMm: 1200 }));
    assert.ok(!sane.calls.includes("start"));
    assert.equal((await scanner.inspect()).configuration.applied, false);
  }
});

test("explicit supported DPI is applied before enabling long mode", async () => {
  const sane = configurableBackend({ dpi: 600 });
  const scanner = createRawScanner(sane);
  await scanner.connect();
  await scanner.configure({ longPaper: true, resolution: 200 });
  assert.deepEqual(sane.calls.slice(1), ["set resolution=200", "set long-paper=true", "set br-y=1200"]);
});
