import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installEpsonFixture } from "./epson-usb-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

async function environment(callback) {
  const directory = await mkdtemp(join(tmpdir(), "receipt-driver-check-"));
  const server = spawn("python3", ["sample-server.py", "--port", "0", "--samples", directory], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Local sample server did not start.")), 10000);
      server.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /http:\/\/localhost:(\d+)\//.exec(output);
        if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Local server exited: ${code}`)); });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(installEpsonFixture);
    await page.goto(`${origin}/sample-input.html`);
    await callback({ page, directory });
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.kill();
    await rm(directory, { recursive: true, force: true });
  }
}

test("compiled epsonds: long geometry/PEDT, exact page-end rows, unchanged RGB bytes, and malformed-page rejection", {
  timeout: 120000,
  skip: !existsSync(join(root, "scanner-driver/build/provenance.json")),
}, async () => {
  await environment(async ({ page }) => {
    const result = await page.evaluate(async () => {
      const module = await LibSANE({ locateFile: (path) => new URL(`/scanner-assets/${path}`, location.href).href });
      const init = module.sane_init();
      const { createRawScanner } = await import("/raw-scanner.mjs");
      const scanner = createRawScanner(module);
      await scanner.connect();
      const baseline = await scanner.inspect();
      let failure;
      try { await scanner.capture(); } catch (error) { failure = error.capture?.scanner; }
      const configured = await scanner.configure({ longPaper: true, maxLengthMm: 1200 });
      let capture = await scanner.capture();
      if (!capture) capture = await scanner.capture(); // Previous PJ produces one idle scanEnd.
      const bytes = new Uint8Array(await capture.blob.arrayBuffer());
      const unchanged = bytes.every((byte) => byte === 170); // Factory defaults are 8-bit Color / 200 DPI.
      await scanner.disconnect();
      await scanner.connect();
      const reopened = await scanner.inspect();
      epsonFixture.paperAvailable = true;
      epsonFixture.missingRow = true;
      await scanner.configure({ longPaper: true, maxLengthMm: 1200 });
      let malformed;
      try {
        let value = await scanner.capture();
        if (!value) value = await scanner.capture();
      } catch (error) { malformed = error.capture?.scanner; }
      await scanner.disconnect();
      return { init: init.status, baseline, failure, configured, captured: capture.scanner,
        dimensions: capture.dimensions, size: bytes.length, unchanged, reopened, malformed, commands: epsonFixture.commands };
    });
    assert.equal(result.init, 0);
    assert.equal(result.baseline.options.find((x) => x.name === "br-y").value, 508);
    assert.equal(result.failure.diagnostics.jam_reported, true);
    assert.equal(result.failure.diagnostics.failure_phase, "parameters");
    assert.equal(result.failure.diagnostics.byte_length, 0);
    assert.equal(result.configured.options.find((x) => x.name === "br-y").value, 1200);
    assert.equal(result.configured.options.find((x) => x.name === "resolution").value, 200);
    assert.equal(result.captured.diagnostics.transport_complete, true);
    assert.equal(result.dimensions.height, Math.round(1000 * 200 / 25.4));
    assert.equal(result.size, result.dimensions.height * result.captured.parameters.bytes_per_line);
    assert.equal(result.unchanged, true);
    assert.equal(result.reopened.options.find((x) => x.name === "long-paper").value, false);
    assert.equal(result.reopened.options.find((x) => x.name === "br-y").value, 508);
    assert.equal(result.malformed.diagnostics.transport_complete, false);
    assert.equal(result.malformed.diagnostics.failure_status, 9);
    const requests = result.commands.filter((x) => x.command === "PARA" && x.payload);
    assert.ok(requests.at(-1).payload.includes("#ADFPEDT"));
    assert.ok(!requests.at(-1).payload.includes("CRP "));
    assert.ok(!requests.at(-1).payload.includes("SKEW"));
  });
});

test("completed long pages remain idle with padded feeder-empty replies and without lft metadata", {
  timeout: 120000,
  skip: !existsSync(join(root, "scanner-driver/build/provenance.json")),
}, async () => {
  await environment(async ({ page }) => {
    const result = await page.evaluate(async () => {
      const module = await LibSANE({ locateFile: (path) => new URL(`/scanner-assets/${path}`, location.href).href });
      module.sane_init();
      const { createRawScanner } = await import("/raw-scanner.mjs");
      const scanner = createRawScanner(module);
      await scanner.connect();
      await scanner.configure({ longPaper: true, maxLengthMm: 1200 });
      const cycles = [];
      for (const emitLft of [true, false]) {
        epsonFixture.emitLft = emitLft;
        epsonFixture.paperAvailable = true;
        let capture = await scanner.capture();
        if (!capture) capture = await scanner.capture();
        const commandStart = epsonFixture.commands.length;
        const idle = [];
        for (const padding of [2, 1, 2]) {
          epsonFixture.emptyPadding = padding;
          try { idle.push((await scanner.capture()) === null); }
          catch (error) { idle.push({ error: error.message, diagnostics: error.capture?.scanner.diagnostics }); }
        }
        cycles.push({ complete: capture?.scanner.diagnostics.transport_complete, idle,
          commands: epsonFixture.commands.slice(commandStart).map((command) => command.command) });
      }
      await scanner.disconnect();
      return cycles;
    });
    for (const cycle of result) {
      assert.equal(cycle.complete, true);
      assert.deepEqual(cycle.idle, [true, true, true]);
      assert.ok(!cycle.commands.includes("TRDT"), "Empty polling must not start another image transfer");
      assert.ok(!cycle.commands.includes("IMG "), "Empty polling must not consume another image");
    }
    assert.ok(result[1].commands.includes("CAN "), "Pending cancellation must end a data session without lft");
  });
});

test("collector UI saves/exports a zero-pixel jam attempt and then captures using the actual patched WASM", {
  timeout: 120000,
  skip: !existsSync(join(root, "scanner-driver/build/provenance.json")),
}, async () => {
  await environment(async ({ page, directory }) => {
    await page.locator("#connectScanner").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Scanner ready"));
    assert.match(await page.locator("#scannerStatus").textContent(), /Long-paper option: available/);
    await page.locator("#startCapture").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("diagnostics only; no image bytes returned"));
    assert.equal(await page.locator("#saved option").count(), 2);
    assert.equal(await page.locator("#stripControls").isVisible(), false);
    assert.match(await page.locator("#tags").inputValue(), /feeder-jam/);
    const downloading = page.waitForEvent("download");
    await page.locator("#export").click();
    const download = await downloading;
    const path = join(directory, "jam-export.zip");
    await download.saveAs(path);
    // The local server has already checksum-verified the same diagnostic bundle.
    assert.ok((await readFile(path)).length > 0);
    await page.locator("#longPaper").check();
    await page.locator("#scanDpi").selectOption("200");
    await page.locator("#startCapture").click();
    await page.waitForFunction(() => document.querySelectorAll("#saved option").length === 3, null, { timeout: 60000 });
    await page.locator("#stopCapture").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Session stopped"));
    const diagnostics = JSON.parse(await page.locator("#diagnostics").textContent());
    assert.equal(diagnostics.diagnostics.transport_complete, true);
    assert.equal(diagnostics.configuration.long_paper_requested, true);
    assert.equal(diagnostics.library.provenance.patch_revision, "receipt-longpaper-2");
    assert.equal(diagnostics.parameters.lines, Math.round(1000 * 200 / 25.4));
    assert.equal((await readdir(directory)).filter((name) => name.startsWith("sample-")).length, 2);
    await page.locator("#disconnectScanner").click();
    await page.waitForFunction(() => document.getElementById("status").textContent === "Scanner disconnected.");
  });
});

test("three long receipts stay displayed through idle/busy polls; a real later jam is saved separately", {
  timeout: 120000,
  skip: !existsSync(join(root, "scanner-driver/build/provenance.json")),
}, async () => {
  await environment(async ({ page, directory }) => {
    await page.locator("#connectScanner").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Scanner ready"));
    await page.locator("#longPaper").check();
    await page.evaluate(() => { epsonFixture.emitLft = false; epsonFixture.busyPolls = 1; });
    await page.locator("#startCapture").click();
    const ids = [];
    for (let receipt = 1; receipt <= 3; receipt++) {
      if (receipt > 1) await page.evaluate((index) => {
        epsonFixture.paperAvailable = true;
        epsonFixture.emitLft = index % 2 === 0;
      }, receipt);
      await page.waitForFunction((count) => document.querySelectorAll("#saved option").length === count + 1 &&
        !document.getElementById("preview").hidden && document.getElementById("preview").naturalHeight > 0,
      receipt, { timeout: 60000 });
      const id = await page.locator("#saved").inputValue();
      ids.push(id);
      // Exercise multiple post-page polls instead of immediately clicking Stop.
      const stats = await page.evaluate(() => {
        epsonFixture.busyPolls = 2;
        return epsonFixture.commands.filter((command) => command.command === "STAT").length;
      });
      await page.waitForFunction((count) => epsonFixture.commands.filter((command) => command.command === "STAT").length >= count + 4,
        stats, { timeout: 15000 });
      assert.equal(await page.locator("#saved option").count(), receipt + 1);
      assert.equal(await page.locator("#saved").inputValue(), id);
      assert.match(await page.locator("#details").textContent(), new RegExp(id));
      assert.equal(await page.locator("#preview").isVisible(), true);
      assert.equal(await page.locator("#status").getAttribute("data-error"), "false");
    }
    assert.equal(new Set(ids).size, 3);
    assert.equal((await readdir(directory)).length, 3);
    const preview = await page.locator("#preview").getAttribute("src");
    await page.evaluate(() => { epsonFixture.statusFault = "PJ"; });
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("remains displayed"));
    assert.equal(await page.locator("#saved option").count(), 5);
    assert.equal(await page.locator("#saved").inputValue(), ids[2]);
    assert.equal(await page.locator("#preview").getAttribute("src"), preview);
    assert.match(await page.locator("#details").textContent(), new RegExp(ids[2]));
    assert.equal(JSON.parse(await page.locator("#diagnostics").textContent()).diagnostics.transport_complete, true);
    const failure = JSON.parse(await page.locator("#sessionFailure").textContent());
    assert.equal(failure.displayed_sample_id, ids[2]);
    assert.equal(failure.scanner.diagnostics.jam_reported, true);
    assert.ok(!ids.includes(failure.sample_id));
    assert.equal((await readdir(directory)).length, 4);
  });
});

test("sample deletion keeps unrelated inputs, handles server failure, and clears deleted loaded inputs", {
  timeout: 60000,
}, async () => {
  await environment(async ({ page, directory }) => {
    const ids = await page.evaluate(async () => {
      const { sampleZip } = await import("/sample-input-utils.mjs");
      const open = indexedDB.open("receipt-sample-inputs", 1);
      const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      canvas.getContext("2d").fillRect(0, 0, 1, 1);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const values = [
        { id: "11111111-1111-4111-8111-111111111111", kind: "real-import", blob: png, extension: "png", dimensions: { width: 1, height: 1 } },
        { id: "22222222-2222-4222-8222-222222222222", kind: "scanner-diagnostic", blob: new Blob([]), extension: "bin" },
        { id: "33333333-3333-4333-8333-333333333333", kind: "scanner-diagnostic", blob: new Blob([]), extension: "bin" },
      ];
      for (const value of values) {
        const bytes = new Uint8Array(await value.blob.arrayBuffer());
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const manifest = { schema_version: 1, id: value.id, source: {
          kind: value.kind, artifact: `original.${value.extension}`, byte_length: bytes.length,
          sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        }, labels: { date: value.extension === "png" ? "2021-09-14" : null, time: "17:21", state: "confirmed",
          page_order: 1, split: "development", tags: [], notes: "", languages: ["eng"] } };
        const zip = sampleZip([{ name: manifest.source.artifact, bytes }, { name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(manifest)) }]);
        const response = await fetch(`/api/samples/${value.id}`, { method: "PUT", headers: { "Content-Type": "application/zip" }, body: zip });
        if (!response.ok) throw new Error(`Test sample save failed: ${response.status}`);
        await new Promise((resolve, reject) => {
          const tx = db.transaction("samples", "readwrite"); tx.objectStore("samples").put({ ...value, manifest });
          tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
        });
      }
      return values.map((value) => value.id);
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#saved option").length === 4);
    await page.locator("#saved").selectOption(ids[0]);
    await page.locator("#load").click();
    await page.waitForFunction(() => document.getElementById("status").textContent === "Loaded saved original and labels.");
    assert.equal(await page.locator("#preview").isVisible(), true);
    // Server failures must retain browser entries and the currently viewed input.
    await page.route("**/api/samples/*", (route) => route.request().method() === "DELETE"
      ? route.fulfill({ status: 507, contentType: "application/json", body: JSON.stringify({ error: "Test failure" }) }) : route.continue());
    await page.locator("#saved").selectOption(ids[1]);
    await page.locator("#deleteSample").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("retained for retry"));
    assert.equal(await page.locator("#saved option").count(), 4);
    assert.equal((await readdir(directory)).length, 3);
    await page.unroute("**/api/samples/*");
    await page.locator("#saved").selectOption(ids[1]);
    await page.locator("#deleteSample").click();
    await page.waitForFunction(() => document.querySelectorAll("#saved option").length === 3);
    assert.equal(await page.locator("#date").inputValue(), "2021-09-14");
    assert.equal(await page.locator("#preview").isVisible(), true);
    assert.equal((await readdir(directory)).length, 2);
    await page.locator("#deleteDiagnostics").click();
    await page.waitForFunction(() => document.querySelectorAll("#saved option").length === 2);
    assert.equal(await page.locator("#deleteDiagnostics").isDisabled(), true);
    assert.deepEqual(await readdir(directory), [`sample-${ids[0]}.zip`]);
    // Deleting the loaded real input clears memory/URLs and cannot re-save it.
    await page.locator("#deleteSample").click();
    await page.waitForFunction(() => document.getElementById("details").textContent === "No input selected.");
    assert.equal(await page.locator("#save").isDisabled(), true);
    assert.equal(await page.locator("#export").isDisabled(), true);
    assert.equal(await page.locator("#preview").isVisible(), false);
    assert.deepEqual(await readdir(directory), []);
    await page.reload();
    assert.equal(await page.locator("#saved option").count(), 1);
  });
});
