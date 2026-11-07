import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installEpsonFixture } from "./epson-usb-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function environment(callback, fixture = false, ocr = false) {
  const directory = await mkdtemp(join(process.env.APP_TEST_TEMP || tmpdir(), "receipt-app-test-"));
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.APP_TEST_PYTHON || "python3", ["-m", "server.run"], {
    cwd: root, env: { ...process.env, PORT: String(port), APP_PUBLIC_URL: origin, OCR_ENABLED: ocr ? "1" : "0",
      STATE_DIR: join(directory, "state"), WORK_DIR: join(directory, "work"), ARCHIVE_DIR: join(directory, "archive"),
      DRIVE_CLIENT_ID: "", DRIVE_CLIENT_SECRET: "", DRIVE_ROOT_ID: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stderr.on("data", bytes => { output = (output + bytes).slice(-10000); });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
      await sleep(100);
    }
    assert.ok(ready, output);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    if (fixture) await page.addInitScript(installEpsonFixture);
    await page.goto(origin);
    await callback({ page, directory, origin });
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    if (server.exitCode === null) await once(server, "exit");
    await rm(directory, { recursive: true, force: true });
  }
}

test("browser queue survives a lost acknowledgment and reload, then review/approval produces a downloadable PDF", { timeout: 120000 }, async () => {
  await environment(async ({ page, directory }) => {
    let loseAcknowledgment = true;
    await page.route("**/api/captures/*/finalize", async route => {
      const response = await route.fetch();
      if (loseAcknowledgment) {
        loseAcknowledgment = false;
        await route.fulfill({ status: 200, contentType: "text/html", body: "Login required" });
      } else await route.fulfill({ response });
    });
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "28px sans-serif";
      context.fillText("Synthetic receipt", 30, 80); context.fillText("2026-09-14 17:21:30", 30, 150); context.fillText("BOTTOM", 30, 1150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("login/error page"));
    assert.match(await page.locator(".capture-panel").textContent(), /1 browser copies pending/);
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".capture-panel").textContent.includes("0 browser copies pending"));
    await page.waitForFunction(() => document.querySelector(".receipt .badge")?.textContent === "ready");
    assert.equal(await page.locator(".receipt").count(), 1);
    await page.getByLabel("Transaction date", { exact: true }).fill("2026-09-14");
    await page.getByLabel("Transaction time", { exact: true }).fill("17:21:30");
    await page.getByLabel("Physical bottom is present").check();
    await page.getByLabel("Selected image is readable").check();
    await page.getByRole("button", { name: "Save review", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Review saved"));
    await page.getByRole("button", { name: "Inspect full-resolution strips & OCR" }).click();
    await page.getByRole("button", { name: "Physical bottom", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".strip img")?.complete && document.querySelector(".strip img").naturalWidth === 640);
    await page.getByRole("button", { name: "Prepare approval", exact: true }).click();
    await page.getByRole("button", { name: "Approve this version", exact: true }).waitFor();
    assert.match(await page.locator(".approval").textContent(), /2026\/09-September\/20260914-1721.pdf/);
    await page.getByLabel("Transaction time", { exact: true }).fill("17:22:30");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Approve this version")?.disabled === true);
    assert.equal(await page.getByRole("button", { name: "Prepare approval", exact: true }).isDisabled(), true);
    const savedEdit = page.waitForResponse(response => response.request().method() === "POST" && /\/api\/receipts\/[a-f0-9-]+$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Save review", exact: true }).click();
    assert.equal((await savedEdit).status(), 200);
    await page.getByRole("button", { name: "Prepare approval", exact: true }).click();
    await page.getByRole("button", { name: "Approve this version", exact: true }).waitFor();
    assert.match(await page.locator(".approval").textContent(), /2026\/09-September\/20260914-1722.pdf/);
    await page.getByRole("button", { name: "Approve this version", exact: true }).click();
    await page.getByRole("link", { name: "Download approved PDF" }).waitFor({ timeout: 30000 });
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download approved PDF" }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "20260914-1722.pdf");
    const saved = join(directory, "approved.pdf");
    await download.saveAs(saved);
    assert.equal((await readFile(saved)).subarray(0, 4).toString(), "%PDF");
    await page.screenshot({ path: join(process.env.APP_TEST_ARTIFACTS || directory, "workspace.png"), fullPage: true });
  });
});

test("production capture UI uses the compiled Epson backend and transfers an unchanged simulated 1,000 mm frame", { timeout: 120000 }, async () => {
  await environment(async ({ page, directory, origin }) => {
    await page.getByRole("button", { name: "Connect Epson scanner", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("receipt-longpaper-2"));
    await page.getByRole("button", { name: "Start session", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".receipt .badge")?.textContent === "ready", null, { timeout: 60000 });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const state = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(state.groups.length, 1);
    const receipt = state.groups[0].receipts[0];
    assert.equal(receipt.date, null); assert.equal(receipt.time, null);
    const evidence = await (await fetch(`${origin}/api/receipts/${receipt.id}/evidence`)).json();
    assert.equal(evidence.capture.height, Math.round(1000 * 200 / 25.4));
    const raw = await readFile(join(directory, "work", "captures", receipt.id, "original.bin"));
    assert.equal(raw.length, evidence.capture.height * evidence.capture.frame.bytes_per_line);
    assert.ok(raw.every(byte => byte === 170));
    assert.match(await page.locator(".capture-panel").textContent(), /0 browser copies pending/);
  }, true);
});

test("OCR proposals prefill editable fields, expose source strips and require explicit review", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      context.fillText("Transaction", 30, 80); context.fillText("2026-09-14 17:21:30", 30, 150); context.fillText("BOTTOM", 30, 1150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "ocr-fixture.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(() => document.querySelector(".proposal strong")?.textContent.includes("OCR timestamp proposal"), null, { timeout: 30000 });
    assert.equal(await page.getByLabel("Transaction date", { exact: true }).inputValue(), "2026-09-14");
    assert.equal(await page.getByLabel("Transaction time", { exact: true }).inputValue(), "17:21:30");
    await page.locator(".proposal summary").click();
    await page.getByRole("button", { name: /Inspect source at row/ }).first().click();
    await page.waitForFunction(() => document.querySelector(".strip img")?.complete && document.querySelector(".strip img").naturalWidth === 640);
    const before = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(before.groups[0].receipts[0].timestamp_review, 1);
    await page.getByLabel("Physical bottom is present").check();
    await page.getByLabel("Selected image is readable").check();
    await page.getByRole("button", { name: "Save review", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Review saved"));
    const after = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(after.groups[0].receipts[0].timestamp_review, 0);
    assert.equal(after.groups[0].receipts[0].field_source, "manual");
  }, false, true);
});

test("fallback provenance and both source branches remain visible in staging", { timeout: 120000 }, async () => {
  await environment(async ({ page }) => {
    await page.route("**/api/receipts/*/evidence", async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.processing) {
        body.processing.extraction = { version: "fixture", status: "proposed", issues: [],
          selected: { date: "2026-09-14", time: "17:21" },
          routing: { selected_engine: "rapidocr", primary_issues: ["ocr_disagreement"] },
          candidates: ["primary", "fallback"].map(branch => ({ id: `${branch}:fixture`, dates: ["2026-09-14"], time: "17:21", issues: [],
            sources: [{ text: `${branch} source <script>untrusted</script>`, pass: `${branch}/discovery`, box: [10, 100, 200, 130], ocr_confidence: 90 }] })) };
        body.processing.ocr = { fallback: { state: "accepted", reason: null, seconds: 1.25 } };
      }
      await route.fulfill({ response, json: body });
    });
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 320, 1200);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "provenance.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.getByText("RapidOCR fallback supplied this proposal. Inspect both engine source lists.", { exact: true }).waitFor();
    assert.match(await page.locator(".proposal").textContent(), /Primary OCR: ocr disagreement/);
    await page.locator(".proposal summary").click();
    assert.equal(await page.locator(".candidate").count(), 2);
    assert.equal(await page.locator(".candidate script").count(), 0);
    await page.getByRole("button", { name: "Inspect source at row 100", exact: true }).last().click();
    await page.waitForFunction(() => document.querySelector(".strip img")?.complete && document.querySelector(".strip img").naturalWidth === 320);
  });
});

test("a receipt-local convention reparses saved OCR and retains its prior analysis", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      context.fillText("Transaction", 30, 80); context.fillText("01/09/2022 12:21:41", 30, 150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "ambiguous.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(() => document.querySelector(".receipt .badge")?.textContent === "ready");
    assert.equal(await page.getByLabel("Transaction date", { exact: true }).inputValue(), "");
    await page.getByText("Date convention & reprocess", { exact: true }).click();
    await page.getByLabel("Numeric date order", { exact: true }).selectOption("DMY");
    await page.getByLabel("Two-digit year century", { exact: true }).selectOption("unknown");
    await page.getByRole("button", { name: "Apply convention to saved OCR", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[type="date"]').value === "2022-09-01", null, { timeout: 30000 });
    const result = await (await fetch(`${origin}/api/state`)).json();
    const receipt = result.groups[0].receipts[0];
    assert.equal(receipt.analysis.mode, "parse");
    assert.equal(receipt.analysis.policy.effective.date_order, "DMY");
    assert.equal(receipt.timestamp_review, 1);
    await page.getByText("Analysis history", { exact: true }).click();
    await page.getByRole("button", { name: "Inspect analysis 1", exact: true }).click();
    assert.match(await page.locator(".analysis-controls pre").textContent(), /ambiguous_numeric_date/);
    assert.equal(await page.getByLabel("Transaction date", { exact: true }).inputValue(), "2022-09-01");
  }, false, true);
});
