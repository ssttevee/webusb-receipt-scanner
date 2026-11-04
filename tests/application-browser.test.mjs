import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
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

async function environment(callback, fixture = false) {
  const directory = await mkdtemp(join(process.env.APP_TEST_TEMP || tmpdir(), "receipt-app-test-"));
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.APP_TEST_PYTHON || "python3", ["-m", "server.run"], {
    cwd: root, env: { ...process.env, PORT: String(port), APP_PUBLIC_URL: origin, OCR_ENABLED: "0",
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
    await page.getByRole("button", { name: "Approve this version", exact: true }).click();
    await page.getByRole("link", { name: "Download approved PDF" }).waitFor({ timeout: 30000 });
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download approved PDF" }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "20260914-1721.pdf");
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
