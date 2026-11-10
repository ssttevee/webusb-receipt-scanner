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
// A ready page proves it by showing its own image; the dialog's state line only appears while a page
// is still working, so readiness is measured on the thing the operator actually looks at.
const waitForReadyPage = (page, timeout = 60000) => page.waitForFunction(() => {
  const image = document.querySelector(".receipt .scan-pane .thumbnail");
  return Boolean(image && image.complete && image.naturalWidth > 0);
}, null, { timeout });

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
    await waitForReadyPage(page);
    // The dialog frames its own scrolling area, so the lone page inside it must not draw a second
    // frame 16px further in.
    assert.deepEqual(await page.evaluate(() => { const style = getComputedStyle(document.querySelector("dialog.editor .receipt"));
      return [style.borderTopWidth, style.borderBottomWidth, style.borderRadius, style.paddingLeft, style.paddingRight]; }),
      ["0px", "0px", "0px", "0px", "0px"], "a single page in the dialog needs no card border of its own");
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
    // The full page on the details screen carries the same raw/final choice as the inspection dialog:
    // one rendering decision per page, so the two windows can never disagree. The control rides above
    // the page, centred on it, and switching the rendering must not move it an eyelash.
    const control = page.locator(".scan-pane .render-toggle");
    const resting = await control.boundingBox();
    assert(await page.evaluate(() => {
      const knob = document.querySelector(".scan-pane .render-toggle").getBoundingClientRect();
      const paper = document.querySelector(".receipt .thumbnail").getBoundingClientRect();
      return knob.width < paper.width - 8 && Math.abs(knob.left + knob.width / 2 - (paper.left + paper.width / 2)) < 2 && knob.bottom <= paper.top + 1;
    }), "the raw/final control must be a compact control centred directly above the page it switches");
    const rawAspect = await page.evaluate(() => { const img = document.querySelector(".receipt .thumbnail");
      return img.naturalWidth / img.naturalHeight; });
    assert.match(await page.locator(".receipt .thumbnail").getAttribute("alt"), /raw scan preview/);
    await control.getByRole("button", { name: "Final binarized", exact: true }).click();
    await page.waitForFunction(() => { const img = document.querySelector(".receipt .thumbnail");
      return img.complete && img.src.includes("render=final") && img.naturalWidth > 0; });
    assert.match(await page.locator(".receipt .thumbnail").getAttribute("alt"), /approved export page preview/);
    assert.equal(await control.getByRole("button", { name: "Raw scan", exact: true }).getAttribute("aria-pressed"), "false");
    const switched = await control.boundingBox();
    assert(Math.abs(switched.x - resting.x) < 0.5 && Math.abs(switched.y - resting.y) < 0.5 && Math.abs(switched.width - resting.width) < 0.5,
      "switching the rendering must leave the control exactly where it was");
    assert(Math.abs(await page.evaluate(() => { const img = document.querySelector(".receipt .thumbnail");
      return img.naturalWidth / img.naturalHeight; }) - rawAspect) < 0.02);  // same page, just rendered
    await control.getByRole("button", { name: "Raw scan", exact: true }).click();
    await page.waitForFunction(() => { const img = document.querySelector(".receipt .thumbnail");
      return !img.src.includes("render=final") && img.complete && img.naturalWidth === 640; });
    await page.getByRole("button", { name: "Inspect full-resolution strips & OCR" }).click();
    await page.getByRole("button", { name: "Physical bottom", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".strip img")?.complete && document.querySelector(".strip img").naturalWidth === 640);
    // The same window, rendered as the approved PDF will archive it: bilevel, trimmed, honouring
    // the page's chosen stamp processing. The toggle must swap pixels without losing the row.
    await page.locator(".inspection-modal").getByRole("button", { name: "Final binarized", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".strip img")?.src.includes("render=final")
      && document.querySelector(".strip img").complete && document.querySelector(".strip img").naturalWidth > 0);
    assert.equal(await page.evaluate(() => document.querySelector(".strip img").alt.includes("binarized export")), true);
    assert.equal(await page.locator(".inspection-modal").getByRole("button", { name: "Raw scan", exact: true }).getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator(".inspection-modal").getByRole("button", { name: "Final binarized", exact: true }).getAttribute("aria-pressed"), "true");
    assert(await page.evaluate(() => document.querySelector(".receipt .thumbnail").src.includes("render=final")));  // one choice, both windows
    const binarizedRow = await page.evaluate(() => new URL(document.querySelector(".strip img").src).searchParams.get("top"));
    await page.locator(".inspection-modal").getByRole("button", { name: "Raw scan", exact: true }).click();
    await page.waitForFunction(row => { const img = document.querySelector(".strip img");
      return !img.src.includes("render=final") && img.complete && img.naturalWidth === 640
        && new URL(img.src).searchParams.get("top") === row; }, binarizedRow);
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
    await waitForReadyPage(page);
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
    await page.locator(".proposal .candidates > summary").click();
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
    await waitForReadyPage(page);
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
    await page.locator(".proposal .candidates > summary").click();
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
    await waitForReadyPage(page);
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
    assert.equal(await page.locator(".cell .act.confirm").count(), 1, "the undated group must not offer a fix the server would refuse");
    assert.ok(await page.locator(`.cell[data-group-id="${blank.id}"] .act.save`).evaluate(button => button.disabled),
      "an undated page can only be ruled by typing its stamp, so Save waits for both halves");
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
    await page.waitForFunction(id => Boolean(document.querySelector(`.approve-row[data-group-id="${id}"] .stamp-slot.blank`)), blank.id, { timeout: 15000 });
    await proposalRow.getByRole("button", { name: "Approve 2026-09-14", exact: true }).click();
    await page.waitForFunction(id => !document.querySelector(`.approve-row[data-group-id="${id}"]`), proposal.id, { timeout: 30000 });
    await page.getByRole("tab", { name: /^Exports/ }).click();
    await page.getByRole("link", { name: "Download approved PDF" }).waitFor({ timeout: 30000 });
    const done = await (await page.request.get(`${origin}/api/state`)).json();
    assert.match(done.groups.find(group => group.id === proposal.id).exports[0].path, /2026\/09-September\/20260914-1721\.pdf/);
  }, false, true);
});

// Page selection belongs where the page's evidence is on screen, so it moved out of the details
// dialog and into the ledger row's fixed left rail: one checkbox per page the row holds.
test("the ledger row carries one page-selection checkbox per page and the details dialog carries none", {
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
    // Same date, same minute, different seconds: the pair shares one staging group, so the row has to
    // carry a checkbox for each page and there is a real split for the selection to perform.
    await importReceipt("first.png", ["Transaction", "2026-09-14 17:21:30", "BOTTOM"]);
    await importReceipt("second.png", ["Transaction", "2026-09-14 17:21:52", "BOTTOM"]);
    let staged;
    for (let attempt = 0; attempt < 250; attempt++) {
      const state = await (await page.request.get(`${origin}/api/state`)).json();
      const pages = state.groups.flatMap(group => group.receipts);
      if (state.groups.length === 1 && pages.length === 2 && pages.every(receipt => receipt.state === "ready")
        && pages.every(receipt => !["queued", "running"].includes(receipt.analysis?.state ?? "ready"))) { staged = state; break; }
      await sleep(200);
    }
    assert.ok(staged, "the two same-minute scans must merge into one staging group");
    const [group] = staged.groups;
    const ids = group.receipts.map(receipt => receipt.id);
    await page.reload();
    const row = page.locator(`.cell[data-group-id="${group.id}"]`);
    await row.waitFor({ timeout: 15000 });
    // One checkbox per page, each named for its own page, in the row's rail.
    const picks = row.locator(".picks .pick");
    assert.equal(await picks.count(), ids.length);
    for (const [index, id] of ids.entries())
      assert.equal(await picks.nth(index).getAttribute("aria-label"), `Select page ${id.slice(0, 8)}`);
    // Ticking a page must not disturb the row it sits in: the title, the crops and the row's own box
    // stay exactly where they were.
    const measure = async () => ({ row: await row.boundingBox(), ident: await row.locator(".ident").boundingBox(),
      stamps: await row.locator(".stamps").boundingBox() });
    const resting = await measure();
    assert.ok(resting.row && resting.ident && resting.stamps, "the row and its evidence must be on screen to measure");
    await picks.first().check();
    assert.equal(await row.getAttribute("data-selected"), "true", "a row must show that a page in it is picked");
    const settled = await measure();
    for (const [name, before] of Object.entries(resting)) assert.deepEqual(settled[name], before, `ticking a page moved the row's ${name}`);
    // A checkbox takes Space natively; it must not swallow the queue keys, and Enter on it must not
    // commit the row's prefilled fields the way Enter in a date field does.
    const versionBefore = (await (await page.request.get(`${origin}/api/state`)).json()).groups.find(item => item.id === group.id).version;
    await picks.first().focus();
    await page.keyboard.press("Enter");
    await sleep(400);
    assert.doesNotMatch(await page.locator('[role="status"]').textContent(), /Review saved/);
    assert.equal((await (await page.request.get(`${origin}/api/state`)).json()).groups.find(item => item.id === group.id).version,
      versionBefore, "Enter on a selection checkbox must not save the row's fields");
    await page.keyboard.press("j");  // the queue keys still work with a checkbox in focus
    assert.equal(await row.getAttribute("data-focused"), "true", "J must step the queue while a selection checkbox holds focus");
    await page.keyboard.press("o");  // and O still opens the row under the cursor
    const editor = page.locator("dialog.editor");
    await editor.waitFor({ state: "visible", timeout: 15000 });
    // Nothing here selects a page any more, and a ready page no longer needs a state line.
    assert.equal(await editor.locator(".pick, [aria-label^='Select page']").count(), 0);
    assert.equal(await editor.locator(".receipt").count(), 2, "both merged pages share this dialog");
    // The card border stays exactly where it does work: two pages in one scroll area are told apart.
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("dialog.editor .receipt")]
      .map(card => getComputedStyle(card).borderTopWidth)), ["1px", "1px"]);
    for (const index of [0, 1]) assert.doesNotMatch(await editor.locator(".receipt").nth(index).textContent(), /Select page/);
    assert.equal(await editor.locator(".receipt .page-state").count(), 0);
    await closeEditor(page);
    await page.waitForFunction(() => !document.querySelector("dialog.editor[open]"), null, { timeout: 15000 });
    await page.getByRole("button", { name: /^Make selected pages a manual group/ }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Selected pages combined"), null, { timeout: 15000 });
    const split = await (await page.request.get(`${origin}/api/state`)).json();
    assert.equal(split.groups.length, 2, JSON.stringify(split.groups.map(item => item.receipts.length)));
    const [moved] = split.groups.filter(item => item.manual === 1);
    assert.ok(moved && moved.receipts.length === 1 && moved.receipts[0].id === ids[0], "the picked page must move out on its own");
    assert.equal(split.groups.find(item => item.id === group.id).receipts.length, 1);
    // The pick is cleared by the combine, so a stale tick cannot move a page into a later grouping.
    await page.waitForFunction(() => [...document.querySelectorAll(".pick")].every(box => !box.checked), null, { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector(".cell[data-selected]"), null, { timeout: 15000 });
  }, false, true);
});

// The row only ever draws two slots of evidence, so a third page has no crop to carry a checkbox.
// Selection lives beside the row instead of on a crop, so every page stays selectable whatever the row
// can show. This is the case that used to lose a page.
test("a page the review row shows no crop for is still selectable for manual grouping", {
  timeout: 240000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    async function importReceipt(name, seconds) {
      const png = await page.evaluate(offset => {
        const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
        const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
        context.fillStyle = "black"; context.font = "32px sans-serif";
        context.fillText("Transaction", 30, 80);
        context.fillText(`2026-09-14 17:21:${String(offset).padStart(2, "0")}`, 30, 150);
        context.fillText("BOTTOM", 30, 220);
        return canvas.toDataURL("image/png").split(",")[1];
      }, seconds);
      await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    }
    for (const [index, seconds] of [[0, 30], [1, 45], [2, 58]].entries()) await importReceipt(`page${index}.png`, seconds);
    let staged;
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await (await page.request.get(`${origin}/api/state`)).json();
      const pages = state.groups.flatMap(group => group.receipts);
      if (state.groups.length === 1 && pages.length === 3 && pages.every(receipt => receipt.state === "ready")
        && pages.every(receipt => !["queued", "running"].includes(receipt.analysis?.state ?? "ready"))) { staged = state; break; }
      await sleep(200);
    }
    assert.ok(staged, "three same-minute scans must merge into one staging group");
    const [group] = staged.groups;
    const ids = group.receipts.map(receipt => receipt.id);
    await page.reload();
    const row = page.locator(`.cell[data-group-id="${group.id}"]`);
    await row.waitFor({ timeout: 15000 });
    // Two slots of evidence, three pages: the row is short one crop, and that is exactly the page the
    // old design lost.
    assert.equal(await row.locator(".stamps .stamp-slot").count(), 2, "the row draws evidence for only two of the pages");
    const picks = row.locator(".picks .pick");
    assert.equal(await picks.count(), 3, "every page of the row keeps a selection control");
    for (const [index, id] of ids.entries()) {
      assert.equal(await picks.nth(index).getAttribute("aria-label"), `Select page ${id.slice(0, 8)}`);
      assert.notEqual(await picks.nth(index).isDisabled(), true, `page ${id.slice(0, 8)} must stay selectable`);
    }
    // The rail holds all three boxes without pushing anything out of the row.
    const bounds = await row.boundingBox();
    for (const index of [0, 1, 2]) {
      const box = await picks.nth(index).boundingBox();
      assert.ok(box && box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width
        && box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height,
      `the checkbox for page ${ids[index].slice(0, 8)} is outside the row`);
    }
    // Tick the page that has no crop, and combine moves that page and nothing else.
    await picks.nth(2).check();
    assert.equal(await row.getAttribute("data-selected"), "true");
    await page.getByRole("button", { name: /^Make selected pages a manual group/ }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Selected pages combined"), null, { timeout: 15000 });
    const split = await (await page.request.get(`${origin}/api/state`)).json();
    const [moved] = split.groups.filter(item => item.manual === 1);
    assert.ok(moved && moved.receipts.length === 1 && moved.receipts[0].id === ids[2],
      "the page with no crop in the row must be the one the selection moves");
    assert.equal(split.groups.find(item => item.id === group.id).receipts.length, 2);
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

test("review rows show their timestamp evidence, prefilled fields and no truncated label at laptop or desktop widths", {
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
    // The evidence column is lazy, so the strips load on demand and must arrive before layout is judged.
    await page.waitForFunction(() => [...document.querySelectorAll(".cell")].every(cell => {
      const images = [...cell.querySelectorAll(".stamp-strip")];
      return images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0);
    }), null, { timeout: 20000 });
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const fit = await page.evaluate(() => {
        const cells = [...document.querySelectorAll(".cell")];
        const column = (cell, selector) => {
          const node = cell.querySelector(selector);
          return node ? Math.round(node.getBoundingClientRect().left) : null;
        };
        return { cells: cells.length,
          heights: new Set(cells.map(cell => Math.round(cell.getBoundingClientRect().height))).size,
          // Rows share their columns: evidence, the form and the exits hold the same x all the way down.
          columns: [...new Set(cells.map(cell => [column(cell, ".stamp-slot"), column(cell, ".stamp-date"), column(cell, ".act.details")].join()))],
          tracks: [...new Set(cells.map(cell => getComputedStyle(cell).gridTemplateColumns.split(" ").length))],
          // The row is two bands: identity and verbs on the header line, evidence and form below it;
          // candidate slots stack so each crop can span the row, and they arrive wide enough to read.
          bands: cells.every(cell => {
            const top = node => node.getBoundingClientRect().top;
            return top(cell.querySelector(".row-actions")) < top(cell.querySelector(".stamps"))
              && top(cell.querySelector(".row-actions")) < top(cell.querySelector(".ruling"));
          }),
          stacked: cells.every(cell => {
            const slots = [...cell.querySelectorAll(".stamp-slot")];
            return slots.length < 2 || slots[1].getBoundingClientRect().top >= slots[0].getBoundingClientRect().bottom;
          }),
          stripWidth: Math.min(...cells.flatMap(cell => [...cell.querySelectorAll(".stamp-strip")]
            .filter(img => !img.classList.contains("page")).map(img => Math.round(img.getBoundingClientRect().width)))),
          clipped: cells.flatMap(cell => [...cell.querySelectorAll(".fixes .pill, .stamp-slot small, .ident")].filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.textContent)),
          // Every row carries the printed evidence, the ruling it starts from, and both exits.
          evidence: cells.filter(cell => cell.querySelectorAll(".stamp-strip").length > 0).length,
          prefilled: cells.filter(cell => cell.querySelector(".stamp-date")?.value === "2026-09-14"
            && cell.querySelector(".stamp-time")?.value.startsWith("17:")).length,
          verbs: cells.filter(cell => cell.querySelector(".act.save") && cell.querySelector(".act.details")).length };
      });
      assert.deepEqual([fit.cells, fit.heights, fit.columns.length, fit.tracks, fit.clipped], [4, 1, 1, [3], []], `at ${width}px`);
      assert.deepEqual([fit.evidence, fit.prefilled, fit.verbs], [4, 4, 4], `at ${width}px`);
      assert.deepEqual([fit.bands, fit.stacked, fit.stripWidth > 420], [true, true, true],
        `the header line must sit above the crops and the form, candidates must stack, and the crops must span the row at ${width}px`);
    }
  }, false, true);
});

test("the details dialog can re-read a wider stamp window and offer exactly what it reads", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      context.fillText("Transaction", 30, 80); context.fillText("2026-09-14 17:21:30", 30, 150);
      context.fillText("THANK YOU", 30, 1150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "recrop.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(() => document.querySelector(".cell .stamp-date")?.value === "2026-09-14", null, { timeout: 90000 });
    await openEditor(page);
    await page.getByRole("button", { name: "Recheck window" }).click({ timeout: 30000 });
    await page.waitForSelector(".recrop-lines button", { timeout: 30000 });
    const offers = await page.locator(".recrop-lines button").allTextContents();
    assert(offers.some(offer => offer.includes("2026-09-14") && offer.includes("17:21:30")),
      `the wider re-read must offer the stamp it re-read, got: ${offers.join(" | ")}`);
    // Using a result only fills the local fields: the page stays dirty until Save review, so a
    // recheck can never rule a scan on its own.
    await page.locator(".recrop-lines button").first().click();
    assert.equal(await page.locator(".editor input[type=\"date\"]").first().inputValue(), "2026-09-14");
    assert.equal(await page.locator(".editor input[type=\"time\"]").first().inputValue(), "17:21:30");
    await page.waitForFunction(() => [...document.querySelectorAll(".editor p.muted")]
      .some(p => p.textContent.includes("Save or reload local field edits")), null, { timeout: 5000 });
    await page.getByRole("button", { name: "Save review" }).first().click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".editor p.muted")]
      .some(p => p.textContent.includes("Save or reload local field edits")), null, { timeout: 30000 });
  }, false, true);
});

test("the details dialog ranks stamp processing and lets the operator choose it", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      // A wide printed stamp line like a real thermal receipt's: the crop that gets ranked is
      // wider than the dialog itself, which is what pushed the caption past its card border.
      context.fillStyle = "black"; context.font = "60px sans-serif";
      context.fillText("Transaction", 30, 80); context.fillText("2026-09-14 17:21:30", 10, 170);
      context.fillText("THANK YOU", 30, 1150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "variants.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(() => document.querySelector(".cell .stamp-date")?.value === "2026-09-14", null, { timeout: 90000 });
    await openEditor(page);
    await page.waitForSelector(".variant-list li", { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll(".variant-list li").length === 4
      && [...document.querySelectorAll(".variant-list img")].every(image => image.complete && image.naturalWidth > 0), null, { timeout: 30000 });
    const rows = await page.evaluate(() => [...document.querySelectorAll(".variant-list li")].map(li => ({
      label: li.querySelector("strong").textContent,
      read: li.querySelector("p.muted").textContent,
      rendered: (() => { const image = li.querySelector("img"); return image.complete && image.naturalWidth > 0; })(),
      inUse: li.textContent.includes("in use"),
      pick: li.textContent.includes("machine's pick"),
    })));
    assert.equal(rows.length, 4, "every recipe the analysis measured must be offered for choice");
    assert(rows.every(row => row.rendered), "each ranked recipe must render its crop beside the numbers");
    assert(rows.some(row => row.read.includes("2026-09-14") && row.read.includes("17:21:30")),
      `the reads must show what OCR found: ${rows.map(row => row.read).join(" | ")}`);
    assert.equal(rows.filter(row => row.inUse).length, 1, "exactly one recipe is in use before the operator says otherwise");
    assert(rows.some(row => row.pick));
    // The caption belongs inside its card: in a narrow window the crop and caption stack instead
    // of the text spilling past the card border and being cut off by the dialog edge.
    for (const width of [560, 980]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      assert(await page.evaluate(() => {
        const dialog = document.querySelector("dialog.editor").getBoundingClientRect();
        return [...document.querySelectorAll(".variant-list li")].every(li => {
          if (li.scrollWidth > li.clientWidth + 1) return false;  // nothing overflows the card itself
          const card = li.getBoundingClientRect();
          return [...li.querySelectorAll("img,div,p,button")].every(node => {
            const box = node.getBoundingClientRect();
            return box.left >= card.left - 1 && box.right <= card.right + 1 && box.right <= dialog.right + 1;
          });
        });
      }), `at ${width}px every variant card must keep its crop and caption inside itself and inside the dialog`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const machinePick = rows.findIndex(row => row.pick);
    const operatorChoice = rows.findIndex((_, index) => index !== machinePick);
    await page.locator(".variant-list li").nth(operatorChoice).getByRole("button", { name: "Use this" }).click();
    await page.waitForFunction(index => {
      const li = [...document.querySelectorAll(".variant-list li")][index];
      return li && li.textContent.includes("in use") && li.querySelector("button:not([disabled])")?.textContent === "Let the machine choose";
    }, operatorChoice, { timeout: 30000 });
    // Handing the choice back undoes it exactly: the machine's ranked first place is in use again.
    await page.getByRole("button", { name: "Let the machine choose" }).click();
    await page.waitForFunction(index => {
      const li = [...document.querySelectorAll(".variant-list li")][index];
      return li && li.textContent.includes("in use") && !li.textContent.includes("Let the machine choose");
    }, machinePick, { timeout: 30000 });
  }, false, true);
});

// Two rulings, two controls. The reading list ranks four recipes because two of them exist only to help
// the OCR see ink, while an archived page is a black-and-white fax page - so the page switch offers only
// the recipes that can become one, and a reading recipe can never redraw it. The fixture is paper lit
// unevenly across its width, which is the case where the two black-and-white recipes archive genuinely
// different pages: a page ruling that changed nothing would be visible here.
test("the archived page is ruled on its own switch, and a reading recipe can never become it", {
  timeout: 180000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d");
      context.fillStyle = "rgb(245,245,245)"; context.fillRect(0, 0, 320, 1200);
      context.fillStyle = "rgb(105,105,105)"; context.fillRect(320, 0, 320, 1200);
      context.fillStyle = "rgb(40,40,40)";
      for (let left = 20; left < 620; left += 60) context.fillRect(left, 400, 20, 300);
      context.font = "32px sans-serif";
      context.fillText("Transaction", 20, 90); context.fillText("2026-09-14 17:21:30", 12, 150);
      context.fillText("THANK YOU", 20, 1150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "uneven.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(() => document.querySelector(".cell .stamp-date")?.value === "2026-09-14", null, { timeout: 90000 });
    await openEditor(page);
    await page.waitForFunction(() => document.querySelectorAll(".variant-list li").length === 4
      && [...document.querySelectorAll(".variant-list img")].every(image => image.complete && image.naturalWidth > 0), null, { timeout: 30000 });
    const ranked = await page.evaluate(() => [...document.querySelectorAll(".variant-list li")].map(li => ({
      key: new URL(li.querySelector("img").src).searchParams.get("variant"),
      label: li.querySelector("strong").textContent.trim(),
    })));
    // Counts the ink of whichever preview is being shown: a page ruling that never reached the pixels
    // would leave these numbers identical, which is the whole point of the fixture's uneven lighting.
    // Ink counted on whichever preview is on screen: a page ruling that never reached the pixels would
    // leave these numbers identical, which is what the fixture's uneven lighting makes visible.
    const ink = (selector = ".receipt .thumbnail") => page.evaluate(target => {
      const image = document.querySelector(target);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 128) dark += 1;
      return { dark, total: canvas.width * canvas.height };
    }, selector);

    const pageSwitch = page.locator(".scan-pane .page-recipe");
    const toggle = page.locator(".scan-pane .render-toggle");
    const offered = await page.evaluate(() => [...document.querySelectorAll(".scan-pane .page-recipe button")]
      .map(button => ({ label: button.textContent.trim(), pressed: button.getAttribute("aria-pressed") })));
    assert.deepEqual(offered.map(item => item.label), ["Local (Sauvola)", "Global threshold"],
      "the page switch offers the black-and-white recipes, by the same names the reading list uses");
    const labels = new Set(offered.map(item => item.label));
    for (const row of ranked) {
      const canBePage = ["sauvola", "otsu"].includes(row.key);
      assert.equal(labels.has(row.label), canBePage,
        `${row.label} (${row.key}) ${canBePage ? "must be" : "must never be"} offered as a page rendering`);
    }
    assert.equal(offered.filter(item => item.pressed === "true").length, 1, "exactly one page recipe is in use");
    assert.equal(offered[0].pressed, "true", "the archive's own recipe is in use before the operator says otherwise");
    assert((await pageSwitch.evaluate(node => node.textContent.replace(/\s+/g, " ").trim())).length < 60,
      "the page switch names its choices and carries no description of its own");
    const resting = { page: await pageSwitch.boundingBox(), toggle: await toggle.boundingBox() };
    assert(await page.evaluate(() => {
      const paper = document.querySelector(".receipt .thumbnail").getBoundingClientRect();
      const centred = box => Math.abs(box.left + box.width / 2 - (paper.left + paper.width / 2)) < 2;
      const switchBox = document.querySelector(".scan-pane .render-toggle").getBoundingClientRect();
      const pageBox = document.querySelector(".scan-pane .page-recipe").getBoundingClientRect();
      return centred(switchBox) && centred(pageBox) && switchBox.bottom <= paper.top
        && pageBox.bottom <= paper.top && pageBox.top >= switchBox.bottom - 1;
    }), "both switches must ride centred above the page, one under the other");

    await toggle.getByRole("button", { name: "Final binarized", exact: true }).click();
    await page.waitForFunction(() => { const image = document.querySelector(".receipt .thumbnail");
      return image.complete && image.src.includes("render=final") && image.naturalWidth > 0; });
    const archive = await ink();
    assert(archive.dark > 1000 && archive.dark < archive.total * 0.3,
      `the archive's own recipe must ink the printed bars without inking the shadow: ${archive.dark} of ${archive.total}`);

    // Ruling the page on the other black-and-white recipe re-renders the preview it promises to archive.
    await pageSwitch.getByRole("button", { name: "Global threshold", exact: true }).click();
    await page.waitForFunction(() => { const image = document.querySelector(".receipt .thumbnail");
      return image.complete && image.src.includes("render=final")
        && new URL(image.src).searchParams.get("page") === "otsu" && image.naturalWidth > 0; }, null, { timeout: 30000 });
    const ruled = await ink();
    assert(ruled.dark > archive.dark + archive.total * 0.1,
      `the page ruling must reach the archived page: ${archive.dark} ink pixels, then ${ruled.dark}`);
    assert.equal(await pageSwitch.getByRole("button", { name: "Local (Sauvola)", exact: true }).getAttribute("aria-pressed"), "false");
    assert.equal(await pageSwitch.getByRole("button", { name: "Global threshold", exact: true }).getAttribute("aria-pressed"), "true");
    // Neither switch moves for the other's ruling, or for its own.
    for (const [name, box] of Object.entries({ "page switch": await pageSwitch.boundingBox(), "raw/final switch": await toggle.boundingBox() })) {
      const before = name === "page switch" ? resting.page : resting.toggle;
      assert(Math.abs(box.x - before.x) < 0.5 && Math.abs(box.y - before.y) < 0.5 && Math.abs(box.width - before.width) < 0.5,
        `ruling the page moved the ${name}`);
    }
    assert.equal(await toggle.getByRole("button", { name: "Final binarized", exact: true }).getAttribute("aria-pressed"), "true",
      "the page ruling cannot undo which rendering is being shown");

    // A reading pick of either kind, including one that cannot be a page, leaves the ruled page alone.
    const readingAid = ranked.findIndex(row => row.key === "reference");
    await page.locator(".variant-list li").nth(readingAid).getByRole("button", { name: "Use this" }).click();
    await page.waitForFunction(index => {
      const li = [...document.querySelectorAll(".variant-list li")][index];
      return li && li.textContent.includes("in use");
    }, readingAid, { timeout: 30000 });
    assert.equal(await page.evaluate(() => document.querySelectorAll(".variant-list li").length), 4,
      "ruling the page must not re-rank or shrink the reading recipes");
    assert.equal((await ink()).dark, ruled.dark, "a reading recipe must never redraw the archived page");
    assert.match(await page.locator(".receipt .thumbnail").getAttribute("src"), /page=otsu/);
    assert.equal(await pageSwitch.getByRole("button", { name: "Global threshold", exact: true }).getAttribute("aria-pressed"), "true",
      "the reading ruling must leave the page's own choice in use");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".variant-list li")]
      .findIndex(li => li.textContent.includes("in use"))), readingAid, "the reading list marks the reading choice in use, not the page choice");
    const saved = await (await page.request.get(`${origin}/api/state`)).json();
    assert.deepEqual([saved.groups[0].receipts[0].binarization, saved.groups[0].receipts[0].page_recipe], ["reference", "otsu"],
      "the two rulings are stored apart, and each stays where it was put");

    // Handing the page to the other recipe reaches exactly the page the archive would have made by
    // itself: the switch's choices and the archive's default are the same processing, not a third thing.
    await pageSwitch.getByRole("button", { name: "Local (Sauvola)", exact: true }).click();
    await page.waitForFunction(() => { const image = document.querySelector(".receipt .thumbnail");
      return image.complete && new URL(image.src).searchParams.get("page") === "sauvola"; }, null, { timeout: 30000 });
    assert.equal((await ink()).dark, archive.dark, "the switch's other choice must produce the archive's own page exactly");

    // Ruled from the strips too: the inspection dialog carries the same switch, offering the same two
    // recipes with the same one in use, and ruling there re-renders the strip without moving the
    // operator off the rows they were reading or nudging either control.
    await page.getByRole("button", { name: "Inspect full-resolution strips & OCR" }).click();
    const stripSwitch = page.locator(".inspection-modal .page-recipe");
    const stripToggle = page.locator(".inspection-modal .render-toggle");
    await stripSwitch.waitFor({ timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".inspection-modal .page-recipe button")]
      .map(button => ({ label: button.textContent.trim(), pressed: button.getAttribute("aria-pressed") }))), offered,
    "the strips must offer the same page recipes as the details screen, with the same recipe in use");
    await stripToggle.getByRole("button", { name: "Final binarized", exact: true }).click();
    await page.waitForFunction(() => { const image = document.querySelector(".strip img");
      return image && image.complete && image.src.includes("render=final")
        && new URL(image.src).searchParams.get("page") === "sauvola"; }, null, { timeout: 30000 });
    const place = await page.evaluate(() => new URL(document.querySelector(".strip img").src).searchParams.get("top"));
    const unruled = await ink(".strip img");
    const restingStrips = { page: await stripSwitch.boundingBox(), toggle: await stripToggle.boundingBox() };
    await stripSwitch.getByRole("button", { name: "Global threshold", exact: true }).click();
    await page.waitForFunction(() => { const image = document.querySelector(".strip img");
      return image.complete && new URL(image.src).searchParams.get("page") === "otsu" && image.naturalWidth > 0; }, null, { timeout: 30000 });
    const ruledStrip = await ink(".strip img");
    assert(ruledStrip.dark > unruled.dark + unruled.total * 0.1,
      `ruling the page among the strips must change the strip: ${unruled.dark} ink pixels, then ${ruledStrip.dark}`);
    assert.equal(await page.evaluate(() => new URL(document.querySelector(".strip img").src).searchParams.get("top")), place,
      "the page ruling must not move the operator off the rows they were reading");
    for (const [name, box] of Object.entries({ "page switch": await stripSwitch.boundingBox(), "raw/final switch": await stripToggle.boundingBox() })) {
      const before = name === "page switch" ? restingStrips.page : restingStrips.toggle;
      assert(Math.abs(box.x - before.x) < 0.5 && Math.abs(box.y - before.y) < 0.5 && Math.abs(box.width - before.width) < 0.5,
        `ruling the page in the strips moved the ${name}`);
    }
    // One page, one recipe: what was ruled among the strips is what the details screen previews.
    await page.waitForFunction(() => { const image = document.querySelector(".receipt .thumbnail");
      return image.complete && new URL(image.src).searchParams.get("page") === "otsu"; }, null, { timeout: 30000 });
    assert.equal(await pageSwitch.getByRole("button", { name: "Global threshold", exact: true }).getAttribute("aria-pressed"), "true",
      "both windows must show the same page recipe in use");
    assert.equal((await ink()).dark, ruled.dark, "the page ruled from the strips is the page the details screen previews");
  }, false, true);
});

test("a row whose scan never resolved a timestamp can be ruled from the row itself", {
  timeout: 120000, skip: spawnSync("tesseract", ["--version"]).status !== 0,
}, async () => {
  await environment(async ({ page, origin }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 1200;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 640, 1200);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      context.fillText("Self service", 30, 80); context.fillText("THANK YOU", 30, 150);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "unreadable.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    // Wait for the scan to finish processing: a row drawn mid-processing has no master to show yet,
    // and its evidence slot is allowed to be blank until the page exists.
    for (let attempt = 0; attempt < 250; attempt++) {
      const receipts = (await (await page.request.get(`${origin}/api/state`)).json()).groups.flatMap(group => group.receipts);
      if (receipts.length === 1 && receipts[0].state === "ready" && !["queued", "running"].includes(receipts[0].analysis?.state ?? "ready")) break;
      await sleep(200);
    }
    await page.waitForFunction(() => document.querySelectorAll(".cell").length === 1, null, { timeout: 30000 });
    // With no candidate to crop, the evidence slot falls back to the page preview and must paint it.
    await page.waitForFunction(() => { const img = document.querySelector(".cell .stamp-strip"); return Boolean(img?.complete && img.naturalWidth > 0); },
      null, { timeout: 15000 });
    const cell = page.locator(".cell").first();
    const identity = await cell.evaluate(node => node.getAttribute("data-group-id"));
    // Nothing was read, so the form starts empty and refuses to save rather than invent a stamp.
    const before = await page.evaluate(id => {
      const row = document.querySelector(`.cell[data-group-id="${id}"]`);
      return { date: row.querySelector(".stamp-date").value, time: row.querySelector(".stamp-time").value,
        saveDisabled: row.querySelector(".act.save").disabled,
        // With no candidate to crop, the evidence slot falls back to the page itself.
        images: [...row.querySelectorAll(".stamp-strip")].map(img => img.getAttribute("src")) };
    }, identity);
    assert.deepEqual([before.date, before.time], ["", ""], "an unresolved page must not be prefilled with a guess");
    assert.ok(before.saveDisabled, "Save waits until both halves are known");
    assert.ok(before.images.some(src => src.endsWith("/image")), "the row still shows the page when no candidate region exists");
    await cell.locator(".stamp-date").fill("2026-09-16");
    await cell.locator(".stamp-time").fill("09:04:11");
    // Enter in a row field commits that row: read, type, Enter, next row.
    await page.locator(".cell .stamp-time").press("Enter");
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Saved 2026-09-16 09:04:11"), null, { timeout: 15000 });
    await page.waitForFunction(id => !document.querySelector(`.cell[data-group-id="${id}"]`), identity, { timeout: 15000 });
    const saved = await (await page.request.get(`${origin}/api/state`)).json();
    const group = saved.groups.find(item => item.id === identity);
    const [page1] = group.receipts;
    assert.deepEqual([page1.date, page1.time], ["2026-09-16", "09:04:11"]);
    assert.equal(page1.field_source, "manual");
    assert.equal(page1.timestamp_review, 0);
    assert.ok(page1.complete && page1.readable, "the ruling attests the page it writes, as the quick path does");
    assert.equal(page1.complete_source, "operator");
    // Settled, it waits on the Approve tab with the page it was ruled from beside it.
    await page.getByRole("tab", { name: /^Approve/ }).click();
    await page.waitForFunction(id => Boolean(document.querySelector(`.approve-row[data-group-id="${id}"]`)), identity, { timeout: 15000 });
    await page.getByRole("button", { name: "Approve 2026-09-16", exact: true }).click();
    await page.waitForFunction(id => !document.querySelector(`.approve-row[data-group-id="${id}"]`), identity, { timeout: 30000 });
  }, false, true);
});
