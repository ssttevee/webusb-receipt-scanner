import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installEpsonFixture } from "./epson-usb-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// Review holds only the groups that need judgment, so ledger rows stay roomy: one line per group,
// full-word issue labels, and action buttons that spell their verb. Fields and approvals live in the row's modal editor.
const openEditor = (page, timeout = 30000) => page.getByRole("button", { name: /^Edit group/ }).first().click({ timeout });
const closeEditor = page => page.getByRole("button", { name: "Close", exact: true }).click();

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
  await environment(async ({ page, directory, origin }) => {
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
    await page.getByLabel("Scan year century", { exact: true }).selectOption("1900");
    await page.reload();
    assert.equal(await page.getByLabel("Scan year century", { exact: true }).inputValue(), "1900");
    await page.waitForFunction(() => document.querySelector(".capture-panel").textContent.includes("0 browser copies pending"));
    await openEditor(page);
    await page.waitForFunction(() => document.querySelector(".receipt .badge")?.textContent === "ready");
    assert.equal(await page.locator(".receipt").count(), 1);
    const intake = await (await page.request.get(`${origin}/api/state`)).json();
    const savedCapture = await (await page.request.get(`${origin}/api/receipts/${intake.groups[0].receipts[0].id}/evidence`)).json();
    assert.equal(savedCapture.capture.timestamp_policy.century, Math.floor(new Date().getFullYear() / 100) * 100);
    await page.getByLabel("Transaction date", { exact: true }).fill("2026-09-14");
    await page.getByLabel("Transaction time", { exact: true }).fill("17:21:30");
    await page.getByLabel("Physical bottom is present").check();
    await page.getByLabel("Selected image is readable").check();
    await page.getByRole("button", { name: "Save review", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Review saved"));
    await page.getByRole("button", { name: "Inspect full-resolution strips & OCR" }).click();
    await page.getByRole("button", { name: "Physical bottom", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".strip img")?.complete && document.querySelector(".strip img").naturalWidth === 640);
    await page.getByRole("button", { name: "Close inspection", exact: true }).click();
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
    await page.waitForFunction(() => !document.querySelector("dialog.editor[open]"), null, { timeout: 15000 });
    await page.getByRole("tab", { name: /^Exports/ }).click();
    await page.getByRole("link", { name: "Download approved PDF" }).waitFor({ timeout: 30000 });
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download approved PDF" }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "20260914-1722.pdf");
    const saved = join(directory, "approved.pdf");
    await download.saveAs(saved);
    assert.equal((await readFile(saved)).subarray(0, 4).toString(), "%PDF");
    await page.getByRole("tab", { name: /^Review/ }).click();
    await page.locator("#panel-review").screenshot({ path: join(process.env.APP_TEST_ARTIFACTS || directory, "workspace.png") });
  });
});

test("production capture UI uses the compiled Epson backend and transfers an unchanged simulated 1,000 mm frame", { timeout: 120000 }, async () => {
  await environment(async ({ page, directory, origin }) => {
    await page.getByRole("button", { name: "Connect Epson scanner", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("receipt-longpaper-2"));
    await page.getByRole("button", { name: "Start session", exact: true }).click();
    await openEditor(page, 60000);
    await page.waitForFunction(() => document.querySelector(".receipt .badge")?.textContent === "ready", null, { timeout: 60000 });
    await closeEditor(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const state = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(state.groups.length, 1);
    const receipt = state.groups[0].receipts[0];
    assert.equal(receipt.date, null); assert.equal(receipt.time, null);
    const evidence = await (await fetch(`${origin}/api/receipts/${receipt.id}/evidence`)).json();
    assert.equal(evidence.capture.height, Math.round(1000 * 200 / 25.4));
    assert.equal(evidence.capture.timestamp_policy.century, Math.floor(new Date().getFullYear() / 100) * 100);
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
    await openEditor(page);
    await page.waitForFunction(() => document.querySelector(".proposal strong")?.textContent.includes("OCR timestamp proposal"), null, { timeout: 30000 });
    assert.equal(await page.getByLabel("Transaction date", { exact: true }).inputValue(), "2026-09-14");
    assert.equal(await page.getByLabel("Transaction time", { exact: true }).inputValue(), "17:21:30");
    await page.locator(".proposal summary").click();
    await page.getByRole("button", { name: /Inspect source at row/ }).first().click();
    await page.waitForFunction(() => document.querySelector(".strip img")?.complete && document.querySelector(".strip img").naturalWidth === 640);
    await page.getByRole("button", { name: "Close inspection", exact: true }).click();
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

test("quick path confirms stored proposals and approves a batch without per-page review clicks", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    page.on("dialog", dialog => dialog.accept());
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      context.fillText("Transaction", 30, 80); context.fillText("2026-09-14 17:21:30", 30, 150); context.fillText("BOTTOM", 30, 1150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "quick-path.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await openEditor(page);
    await page.waitForFunction(() => document.querySelector(".proposal strong")?.textContent.includes("OCR timestamp proposal"), null, { timeout: 30000 });
    await closeEditor(page);
    await page.getByRole("button", { name: /^Confirm ready pages/ }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Confirmed 1 pages"), null, { timeout: 15000 });
    const confirmed = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(confirmed.groups[0].receipts[0].field_source, "confirmed");
    assert.equal(confirmed.groups[0].receipts[0].timestamp_review, 0);
    // The confirmed group has nothing left to fix, so it leaves the ledger for the Approve tab,
    // where its strip carries the accepted timestamp and Fix reopens the review dialog.
    await page.getByRole("tab", { name: /^Approve/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".approve-row").length === 1, null, { timeout: 30000 });
    const quickRow = page.locator(".approve-row").first();
    await page.waitForFunction(() => { const img = document.querySelector(".approve-row img.stamp-strip"); return Boolean(img && img.complete && img.naturalWidth > 0); }, null, { timeout: 15000 });
    assert.ok(await quickRow.locator("img.stamp-strip").evaluate(img => img.complete && img.naturalWidth > 0),
      "the row must show the binarized timestamp region the proposal was accepted from");
    await quickRow.getByRole("button", { name: "Fix 2026-09-14" }).click();
    await page.waitForFunction(() => document.querySelector("dialog.editor[open]")?.getAttribute("aria-label") === "Review group 2026-09-14", null, { timeout: 15000 });
    await closeEditor(page);
    await page.waitForFunction(() => !document.querySelector("dialog.editor"), null, { timeout: 5000 });
    await page.getByRole("button", { name: /^Approve ready groups/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".group .badge")].some(badge => badge.textContent === "approved"), null, { timeout: 30000 });
    await page.getByRole("tab", { name: /^Exports/ }).click();
    await page.getByRole("link", { name: "Download approved PDF" }).waitFor({ timeout: 30000 });
    const quick = await (await fetch(`${origin}/api/state`)).json();
    assert.match(quick.groups[0].exports[0].path, /2026\/09-September\/20260914-1721\.pdf/);
  }, false, true);
});

test("deleting an approved scan leaves the exports list, its rows, and its files on disk", { timeout: 120000 }, async () => {
  await environment(async ({ page, directory, origin }) => {
    page.on("dialog", dialog => dialog.accept());
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "28px sans-serif";
      context.fillText("Synthetic receipt", 30, 80); context.fillText("2026-09-14 17:21:30", 30, 150); context.fillText("BOTTOM", 30, 1150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "to-delete.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await openEditor(page);
    await page.waitForFunction(() => document.querySelector(".receipt .badge")?.textContent === "ready");
    await page.getByLabel("Transaction date", { exact: true }).fill("2026-09-14");
    await page.getByLabel("Transaction time", { exact: true }).fill("17:21:30");
    await page.getByLabel("Physical bottom is present").check();
    await page.getByLabel("Selected image is readable").check();
    await page.getByRole("button", { name: "Save review", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Review saved"));
    await page.getByRole("button", { name: "Prepare approval", exact: true }).click();
    await page.getByRole("button", { name: "Approve this version", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("dialog.editor[open]"), null, { timeout: 15000 });
    await page.getByRole("tab", { name: /^Exports/ }).click();
    await page.getByRole("link", { name: "Download approved PDF" }).waitFor({ timeout: 30000 });
    const approved = await (await fetch(`${origin}/api/state`)).json();
    const [group] = approved.groups;
    const exportId = group.exports[0].id;
    await access(join(directory, "archive", group.exports[0].path));
    await access(join(directory, "archive", ".exports", exportId));
    await page.getByRole("button", { name: "Delete approved scan" }).click();
    await page.getByRole("heading", { name: "No approved exports yet" }).waitFor({ timeout: 15000 });
    assert.equal(await page.getByRole("link", { name: "Download approved PDF" }).count(), 0);
    assert.equal((await (await fetch(`${origin}/api/state`)).json()).groups.length, 0);
    await assert.rejects(access(join(directory, "archive", group.exports[0].path)));
    await assert.rejects(access(join(directory, "archive", ".exports", exportId)));
    await assert.rejects(access(join(directory, "work", "captures", group.receipts[0].id)));
  });
});

test("the sidebar expected month defaults to last month and resolves an ambiguous numeric date", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page }) => {
    const control = page.getByLabel("Expected receipt month", { exact: true });
    const expected = new Date(); expected.setDate(1); expected.setMonth(expected.getMonth() - 1);
    assert.equal(await control.inputValue(), `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}`);
    await control.fill("2022-09");
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      context.fillText("Transaction", 30, 80); context.fillText("05/09/2022 12:21:41", 30, 150); context.fillText("BOTTOM", 30, 1150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "expected-month.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await openEditor(page);
    await page.waitForFunction(() => document.querySelector(".proposal strong")?.textContent.includes("OCR timestamp proposal"), null, { timeout: 30000 });
    assert.equal(await page.getByLabel("Transaction date", { exact: true }).inputValue(), "2022-09-05");
    await page.reload();
    assert.equal(await control.inputValue(), "2022-09");
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
    await openEditor(page);
    await page.getByText("RapidOCR fallback supplied this proposal. Inspect both engine source lists.", { exact: true }).waitFor();
    assert.match(await page.locator(".proposal").textContent(), /Primary OCR: ocr disagreement/);
    await page.locator(".proposal summary").click();
    assert.equal(await page.locator(".candidate").count(), 2);
    assert.equal(await page.locator(".candidate script").count(), 0);
    await page.getByRole("button", { name: "Inspect source at row 100", exact: true }).last().click();
    await page.waitForFunction(() => document.querySelector(".strip img")?.complete && document.querySelector(".strip img").naturalWidth === 320);
    await page.getByRole("button", { name: "Close inspection", exact: true }).click();
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
    await openEditor(page);
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

test("scan century defaults to this century and persists for later imports", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    assert.equal(await page.getByLabel("Scan year century", { exact: true }).inputValue(), "current");
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      context.fillText("Transaction", 30, 80); context.fillText("08/14/26 17:21:30", 30, 150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    async function importReceipt(count) {
      await page.locator('input[type="file"]').setInputFiles({ name: "two-digit-year.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
      for (let attempt = 0; attempt < 150; attempt++) {
        const state = await (await fetch(`${origin}/api/state`)).json();
        const receipts = state.groups.flatMap(group => group.receipts);
        if (receipts.length === count && receipts.every(receipt => receipt.state === "ready")) {
          return receipts.sort((a, b) => b.created - a.created)[0];
        }
        await sleep(200);
      }
      assert.fail("The imported receipt did not complete OCR");
    }
    const first = await importReceipt(1);
    const firstEvidence = await (await fetch(`${origin}/api/receipts/${first.id}/evidence`)).json();
    assert.equal(first.date, `${Math.floor(new Date().getFullYear() / 100) * 100 + 26}-08-14`, JSON.stringify({ receipt: first, evidence: firstEvidence }));
    assert.equal(first.analysis.policy.source, "scan_settings");
    assert.equal(first.timestamp_review, 1);
    await page.getByLabel("Scan year century", { exact: true }).selectOption("1900");
    await page.reload();
    assert.equal(await page.getByLabel("Scan year century", { exact: true }).inputValue(), "1900");
    assert.equal((await importReceipt(2)).date, "1926-08-14");
    await page.getByLabel("Scan year century", { exact: true }).selectOption("none");
    await page.reload();
    assert.equal(await page.getByLabel("Scan year century", { exact: true }).inputValue(), "none");
    const third = await importReceipt(3);
    assert.equal(third.date, null);
    assert.equal(third.analysis.policy.effective.century, null);
    const state = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(state.groups.flatMap(group => group.receipts).find(receipt => receipt.id === first.id).date, first.date);
  }, false, true);
});

test("the ledger confirms a proposal-carrying page in one action and falls back to attest after a manual review", {
  timeout: 180000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    async function importReceipt(name, lines) {
      const png = await page.evaluate(text => {
        const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
        const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
        context.fillStyle = "black"; context.font = "32px sans-serif";
        text.forEach((line, index) => context.fillText(line, 30, 80 + index * 70));
        return canvas.toDataURL("image/png").split(",")[1];
      }, lines);
      await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    }
    await importReceipt("proposal.png", ["Transaction", "2026-09-14 17:21:30", "BOTTOM"]);
    await importReceipt("manual.png", ["Self service", "THANK YOU"]);
    let groups;
    for (let attempt = 0; attempt < 250; attempt++) {
      groups = (await (await page.request.get(`${origin}/api/state`)).json()).groups;
      const receipts = groups.flatMap(group => group.receipts);
      if (groups.length === 2 && receipts.length === 2 && receipts.every(receipt => receipt.state === "ready")
        && receipts.every(receipt => !["queued", "running"].includes(receipt.analysis?.state ?? "ready"))) break;
      await sleep(200);
    }
    const proposal = groups.find(group => group.receipts[0]?.date === "2026-09-14");
    const blank = groups.find(group => proposal && group.id !== proposal.id);
    assert.ok(proposal && blank && groups.length === 2, JSON.stringify(groups.map(group => group.receipts[0]?.date)));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".cell").length === 2, null, { timeout: 30000 });
    // An image import proves nothing about transport, so bottom and legibility start unattested -
    // but one Confirm call sets both flags and the review in a single server-side UPDATE, so the
    // ledger offers Confirm rather than a two-step attest, and the undated page gets no half-fix.
    const proposalCell = page.locator(`.cell[data-group-id="${proposal.id}"]`);
    assert.equal(await proposalCell.getAttribute("data-severity"), "blocked");
    assert.match(await proposalCell.getAttribute("title"), /attest bottom · attest legible$/);
    assert.match(await proposalCell.locator(".act.confirm").getAttribute("aria-label"), /also attests bottom and legibility/);
    assert.equal(await page.locator(".cell .act").count(), 1, "the undated group must not offer a fix the server would refuse");
    // Type a review by hand without the checkboxes: the proposal is gone, so Confirm can no
    // longer reach this page and the ledger must fall back to attest.
    await page.getByRole("button", { name: `Edit group #${blank.id.slice(0, 8)}` }).click();
    await page.waitForFunction(() => Boolean(document.querySelector("dialog.editor[open]")), null, { timeout: 15000 });
    await page.getByLabel("Transaction date", { exact: true }).fill("2026-09-15");
    await page.getByLabel("Transaction time", { exact: true }).fill("09:04:11");
    assert.equal(await page.getByLabel("Physical bottom is present").isChecked(), false);
    assert.equal(await page.getByLabel("Selected image is readable").isChecked(), false);
    await page.getByRole("button", { name: "Save review", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Review saved"), null, { timeout: 15000 });
    await closeEditor(page);
    await page.waitForFunction(() => !document.querySelector("dialog.editor"), null, { timeout: 5000 });
    await page.waitForFunction(id => Boolean(document.querySelector(`.cell[data-group-id="${id}"] .act.attest`)), blank.id, { timeout: 15000 });
    await page.locator(`.cell[data-group-id="${blank.id}"] .act.attest`).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Attested bottom"), null, { timeout: 15000 });
    // A manual review plus attestation settles the group: it leaves the ledger entirely.
    await page.waitForFunction(id => !document.querySelector(`.cell[data-group-id="${id}"]`), blank.id, { timeout: 15000 });
    // Back to the one-call path. One job, one name: the row button and the toolbar button are
    // the same verb at two scopes.
    assert.match(await page.getByRole("button", { name: /^Confirm ready pages/ }).textContent(), /\(1\)/);
    await page.locator(`.cell[data-group-id="${proposal.id}"] .act.confirm`).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Confirmed 2026-09-14"), null, { timeout: 15000 });
    const confirmed = await (await page.request.get(`${origin}/api/state`)).json();
    const [confirmedPage] = confirmed.groups.find(group => group.id === proposal.id).receipts;
    assert.equal(confirmedPage.field_source, "confirmed");
    assert.equal(confirmedPage.timestamp_review, 0);
    assert.equal(confirmedPage.complete, 1);
    assert.equal(confirmedPage.readable, 1);
    assert.equal(confirmedPage.complete_source, "operator", "the approval snapshot must be able to say who attested the bottom");
    // Confirming settles the proposal group too, so it crosses over to the Approve tab: strip,
    // stamp, and a row-scoped Approve. The hand-typed group shows the empty slot beside it.
    await page.waitForFunction(id => !document.querySelector(`.cell[data-group-id="${id}"]`), proposal.id, { timeout: 15000 });
    await page.getByRole("tab", { name: /^Approve/ }).click();
    const proposalRow = page.locator(`.approve-row[data-group-id="${proposal.id}"]`);
    await proposalRow.waitFor({ timeout: 15000 });
    await page.waitForFunction(id => { const img = document.querySelector(`.approve-row[data-group-id="${id}"] img.stamp-strip`); return Boolean(img && img.complete && img.naturalWidth > 0); }, proposal.id, { timeout: 15000 });
    await page.waitForFunction(id => Boolean(document.querySelector(`.approve-row[data-group-id="${id}"] .stamp-fallback`)), blank.id, { timeout: 15000 });
    await proposalRow.getByRole("button", { name: "Approve 2026-09-14", exact: true }).click();
    await page.waitForFunction(id => !document.querySelector(`.approve-row[data-group-id="${id}"]`), proposal.id, { timeout: 30000 });
    await page.getByRole("tab", { name: /^Exports/ }).click();
    await page.getByRole("link", { name: "Download approved PDF" }).waitFor({ timeout: 30000 });
    const done = await (await page.request.get(`${origin}/api/state`)).json();
    assert.match(done.groups.find(group => group.id === proposal.id).exports[0].path, /2026\/09-September\/20260914-1721\.pdf/);
  }, false, true);
});

test("a dense confident scan arrives legibility auto-checked, leaving one keystroke for the bottom", {
  timeout: 180000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      const lines = ["MARTHA'S CORNER CAFE", "42 RIVER ROAD SPRINGFIELD", "SUBTOTAL 9.95 TAX 2.45",
        "VISA DEBIT TOTAL 12.40", "2026-09-14 17:21:30", "AUTH 448312 THANK YOU"];
      lines.forEach((line, index) => context.fillText(line, 30, 90 + index * 90));
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "dense.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    let groups;
    for (let attempt = 0; attempt < 250; attempt++) {
      groups = (await (await page.request.get(`${origin}/api/state`)).json()).groups;
      const receipts = groups.flatMap(group => group.receipts);
      if (receipts.length === 1 && receipts[0].state === "ready" && !["queued", "running"].includes(receipts[0].analysis?.state ?? "ready")) break;
      await sleep(200);
    }
    const [dense] = groups[0].receipts;
    assert.equal(dense.date, "2026-09-14", "the fixture must OCR cleanly enough to carry a timestamp proposal");
    assert.equal(dense.readable, 1);
    assert.equal(dense.readable_source, "ocr", "a machine attestation must name itself as the source");
    assert.equal(dense.complete, 0, "legibility being settled must not touch the physical bottom");
    assert.equal(dense.complete_source, null);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".cell").length === 1, null, { timeout: 30000 });
    const cell = page.locator(".cell").first();
    assert.match(await cell.getAttribute("title"), /attest bottom$/, "the ledger stops asking for the legibility attestation");
    // The editor agrees: the tick arrives pre-set with a provenance note beside it.
    await page.getByRole("button", { name: "Edit group 2026-09-14" }).click();
    await page.waitForFunction(() => Boolean(document.querySelector("dialog.editor[open]")), null, { timeout: 15000 });
    assert.equal(await page.getByLabel("Selected image is readable").isChecked(), true);
    assert.equal(await page.getByLabel("Physical bottom is present").isChecked(), false);
    assert.match(await page.locator("dialog.editor .proof").textContent(), /auto-checked/);
    await closeEditor(page);
    await page.waitForFunction(() => !document.querySelector("dialog.editor"), null, { timeout: 5000 });
    // One Confirm then covers the bottom attestation and the date confirmation together.
    await page.waitForFunction(() => Boolean(document.querySelector(".cell .act.confirm")), null, { timeout: 15000 });
    assert.equal(await page.locator(".cell .act.attest").count(), 0, "no separate attestation once legibility is settled and Confirm covers the rest");
    await page.locator(".cell .act.confirm").click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Confirmed 2026-09-14"), null, { timeout: 15000 });
    // One Confirm settles it, so the group crosses over to the Approve tab for its single click.
    await page.waitForFunction(() => !document.querySelector(".cell"), null, { timeout: 15000 });
    await page.getByRole("tab", { name: /^Approve/ }).click();
    const denseRow = page.locator(".approve-row").first();
    await denseRow.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => { const img = document.querySelector(".approve-row img.stamp-strip"); return Boolean(img && img.complete && img.naturalWidth > 0); }, null, { timeout: 15000 });
    await denseRow.getByRole("button", { name: "Approve 2026-09-14", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".approve-row"), null, { timeout: 30000 });
    await page.getByRole("tab", { name: /^Exports/ }).click();
    await page.getByRole("link", { name: "Download approved PDF" }).waitFor({ timeout: 30000 });
    const done = await (await page.request.get(`${origin}/api/state`)).json();
    assert.match(done.groups[0].exports[0].path, /2026\/09-September\/20260914-1721\.pdf/);
  }, false, true);
});

test("the keyboard cursor steps the ledger and X opens the focused group with its date field active", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    for (const lines of [
      ["Transaction", "2026-09-14 17:21:30", "BOTTOM"],
      ["Self service", "THANK YOU"],
    ]) {
      const png = await page.evaluate(text => {
        const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
        const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
        context.fillStyle = "black"; context.font = "32px sans-serif";
        text.forEach((line, index) => context.fillText(line, 30, 80 + index * 70));
        return canvas.toDataURL("image/png").split(",")[1];
      }, lines);
      await page.locator('input[type="file"]').setInputFiles({ name: `stepping-${lines.length}.png`, mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    }
    let groups;
    for (let attempt = 0; attempt < 200; attempt++) {
      groups = (await (await page.request.get(`${origin}/api/state`)).json()).groups;
      const receipts = groups.flatMap(group => group.receipts);
      const dated = receipts.filter(receipt => receipt.date).flatMap(receipt => receipt.analysis?.state ?? "ready");
      if (groups.length === 2 && receipts.length === 2 && receipts.every(receipt => receipt.state === "ready")
        && receipts.some(receipt => receipt.date) && !dated.some(state => ["queued", "running"].includes(state))) break;
      await sleep(200);
    }
    assert.equal(groups.length, 2, "one dated and one undated group");
    const blank = groups.find(group => !group.receipts.some(receipt => receipt.date));
    const dated = groups.find(group => blank.id !== group.id);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".cell").length === 2, null, { timeout: 30000 });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("j");
    // Undated groups lead the queue: they need the most judgment.
    const stepped = await page.evaluate(() => [...document.querySelectorAll(".cell")].map(cell => `${cell.dataset.groupId.slice(0, 8)} "${cell.querySelector(".ident")?.textContent.trim()}"`));
    assert.equal(await page.evaluate(() => document.querySelector(".cell[data-focused]")?.dataset.groupId), blank.id, `ledger order was [${stepped}]`);
    await page.keyboard.press("x");
    await page.waitForFunction(() => Boolean(document.querySelector("dialog.editor[open]")), null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => document.querySelector("dialog.editor")?.getAttribute("aria-label")), `Review group #${blank.id.slice(0, 8)}`);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("dialog.editor .field-grid input[type=\"date\"]")), true,
      "X must land the caret in the date field of the focused group, not any other group");
    await page.keyboard.press("Escape");
    // Wait for the dialog to unmount, not just lose [open]: the native close event removes
    // [open] a frame before the app's editingId state flush, and the key handler guards on it.
    await page.waitForFunction(() => !document.querySelector("dialog.editor"), null, { timeout: 5000 });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("j");
    assert.equal(await page.evaluate(() => document.querySelector(".cell[data-focused]")?.dataset.groupId), dated.id,
      "the cursor must survive opening and closing an editor, then keep stepping");
  }, false, true);
});

test("review rows keep one readable line and no full-word fix label truncates at laptop or desktop widths", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page }) => {
    for (let index = 0; index < 4; index++) {
      const png = await page.evaluate(minute => {
        const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
        const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
        context.fillStyle = "black"; context.font = "32px sans-serif";
        context.fillText("Transaction", 30, 80); context.fillText(`2026-09-14 17:${minute}:30`, 30, 150); context.fillText("BOTTOM", 30, 1150);
        return canvas.toDataURL("image/png").split(",")[1];
      }, 21 + index); // distinct minutes keep four separate groups
      await page.locator('input[type="file"]').setInputFiles({ name: `dense-${index}.png`, mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    }
    await page.waitForFunction(() => [...document.querySelectorAll(".cell .ident")].filter(ident => ident.textContent.includes("2026-09-14")).length === 4,
      null, { timeout: 90000 });
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const fit = await page.evaluate(() => {
        const cells = [...document.querySelectorAll(".cell")];
        return { cells: cells.length,
          heights: new Set(cells.map(cell => Math.round(cell.getBoundingClientRect().height))).size,
          clipped: cells.flatMap(cell => [...cell.querySelectorAll(".fixes .pill")].filter(pill => pill.scrollWidth > pill.clientWidth + 1).map(pill => pill.textContent)),
          tracks: getComputedStyle(document.querySelector(".ledger")).gridTemplateColumns.split(" ").length };
      });
      assert.deepEqual([fit.cells, fit.heights, fit.clipped], [4, 1, []], `at ${width}px`);
      assert.equal(fit.tracks, 1, `at ${width}px`);
    }
  }, false, true);
});
