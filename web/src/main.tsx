import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import Dexie, { type Table } from "dexie";
import "./style.css";

type Frame = { format: number; depth: number; bytes_per_line: number; pixels_per_line: number; lines: number; last_frame: boolean };
type ScannerCapture = { blob: Blob; dimensions: { width: number; height: number }; scanner: {
  parameters: Frame; resolution: { x: number; y: number }; diagnostics: { transport_complete: boolean }; [key: string]: unknown } };
type Manifest = { id: string; kind: "scanner-raw" | "image"; sha256: string; byte_length: number;
  width: number; height: number; dpi_x: number; dpi_y: number; transport_complete: boolean;
  languages: string[]; frame?: Frame; scanner?: Record<string, unknown> };
type Pending = { id: string; created: number; blob: Blob; manifest: Manifest };
type Diagnostic = { id: string; blob: Blob; metadata: unknown };
type Receipt = { id: string; group_id: string; date: string | null; time: string | null; state: string;
  complete: number; readable: number; vendor: string | null; error: string | null; languages: string[] };
type Export = { id: string; path: string; state: string; drive_id: string | null };
type Group = { id: string; version: number; state: string; manual: number; receipts: Receipt[]; exports: Export[] };
type Job = { id: string; kind: string; target: string; state: string; attempts: number; error: string | null };
type State = { groups: Group[]; jobs: Job[]; drive: { configured: boolean; connected: boolean } };
type Reservation = { id: string; path: string; version: number; note?: string | null };

const database = new Dexie("receipt-transfer-queue") as Dexie & { pending: Table<Pending>; diagnostics: Table<Diagnostic> };
database.version(1).stores({ pending: "id,created", diagnostics: "id" });

async function api<T = Record<string, unknown>>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(path, body === undefined && method === "GET" ? {} : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Server acknowledgment was replaced by a login/error page. Reauthenticate, then retry; browser copies are retained.");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : `Request rejected (HTTP ${response.status})`);
  return result;
}

async function sha256(blob: Blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
}

let uploadRunning = false;
async function uploadPending(onStatus: (value: string) => void, onChange: () => void) {
  if (uploadRunning) return;
  uploadRunning = true;
  try {
    while (true) {
      const pending = await database.pending.orderBy("created").first();
      if (!pending) break;
      const session = await api<{ id: string; chunk_size: number; received: number[]; finalized: boolean }>("/api/captures", pending.manifest);
      if (session.id !== pending.id || session.chunk_size !== 4 * 1048576) throw new Error("Capture session acknowledgment mismatch");
      if (!session.finalized) {
        for (let index = 0; index < Math.ceil(pending.blob.size / session.chunk_size); index++) {
          if (session.received.includes(index)) continue;
          const block = pending.blob.slice(index * session.chunk_size, (index + 1) * session.chunk_size);
          const response = await fetch(`/api/captures/${pending.id}/chunks/${index}`, {
            method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: block,
          });
          if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Chunk save unacknowledged; resume after reconnecting");
          const saved = await response.json();
          if (!saved.durable || saved.id !== pending.id || saved.index !== index || saved.sha256 !== await sha256(block)) throw new Error("Chunk acknowledgment mismatch");
        }
      }
      const saved = await api<{ id: string; sha256: string; durable: boolean }>(`/api/captures/${pending.id}/finalize`);
      if (!saved.durable || saved.id !== pending.id || saved.sha256 !== pending.manifest.sha256) throw new Error("Final save acknowledgment mismatch");
      await database.pending.delete(pending.id);
      onChange();
      onStatus("Capture durably received. Processing has been queued.");
    }
  } catch (error) { onStatus(error instanceof Error ? error.message : String(error)); }
  finally { uploadRunning = false; onChange(); }
}

function ReceiptEditor({ receipt, group, refresh, selected, select, report }: {
  receipt: Receipt; group: Group; refresh: () => Promise<void>; selected: boolean;
  select: (value: boolean) => void; report: (value: string) => void;
}) {
  const [date, setDate] = useState(receipt.date ?? "");
  const [clock, setClock] = useState(receipt.time ?? "");
  const [vendor, setVendor] = useState(receipt.vendor ?? "");
  const [complete, setComplete] = useState(Boolean(receipt.complete));
  const [readable, setReadable] = useState(Boolean(receipt.readable));
  const [inspection, setInspection] = useState(false);
  const [row, setRow] = useState(0);
  const [height, setHeight] = useState(512);
  const [evidence, setEvidence] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [baseVersion, setBaseVersion] = useState(group.version);
  const stale = baseVersion !== group.version;
  useEffect(() => { if (receipt.state === "ready") setBaseVersion(group.version); }, [receipt.state]);
  const editable = group.state === "staging" && receipt.state === "ready";
  async function inspect() {
    try {
      const result = await api<{ capture: { height: number }; processing: unknown }>(`/api/receipts/${receipt.id}/evidence`, undefined, "GET");
      setHeight(result.capture.height); setEvidence(result.processing); setInspection(!inspection);
    } catch (error) { report(String(error)); }
  }
  return <article class="receipt">
    <header class="row"><label><input type="checkbox" checked={selected} disabled={group.state !== "staging"}
      onChange={event => select(event.currentTarget.checked)} /> Select page <code>{receipt.id.slice(0, 8)}</code></label>
      <span class="badge">{receipt.state}</span></header>
    {receipt.state === "ready" && <img class="thumbnail" src={`/api/receipts/${receipt.id}/image`} alt={`Receipt ${receipt.id.slice(0, 8)} preview`} loading="lazy" onClick={inspect} />}
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true);
      try { const saved = await api<{ version: number }>(`/api/receipts/${receipt.id}`, { version: baseVersion, date: date || null, time: clock || null,
        vendor: vendor || null, complete, readable }); setBaseVersion(saved.version); await refresh(); report("Review saved. Same-minute staging groups updated."); }
      catch (error) { report(String(error)); } finally { setBusy(false); }
    }}>
      <fieldset disabled={!editable || busy || stale}>
        <label>Transaction date<input type="date" value={date} onInput={event => setDate(event.currentTarget.value)} /></label>
        <label>Transaction time<input type="time" step="1" value={clock} onInput={event => setClock(event.currentTarget.value)} /></label>
        <label>Vendor hint (optional)<input value={vendor} maxLength={200} onInput={event => setVendor(event.currentTarget.value)} /></label>
        <label class="check"><input type="checkbox" checked={complete} onChange={event => setComplete(event.currentTarget.checked)} /> Physical bottom is present</label>
        <label class="check"><input type="checkbox" checked={readable} onChange={event => setReadable(event.currentTarget.checked)} /> Selected image is readable</label>
        <button type="submit">Save review</button>
      </fieldset>
    </form>
    {stale && editable && <p role="alert">This group changed. <button class="secondary" onClick={() => {
      setDate(receipt.date ?? ""); setClock(receipt.time ?? ""); setVendor(receipt.vendor ?? "");
      setComplete(Boolean(receipt.complete)); setReadable(Boolean(receipt.readable)); setBaseVersion(group.version);
    }}>Reload latest review</button></p>}
    <p class="muted">Use the earliest supported transaction timestamp. Missing fields stay in staging. {receipt.languages.join(" + ")}</p>
    {receipt.error && <p role="alert">{receipt.error}</p>}
    {group.state === "staging" && <p><button class="secondary" disabled={busy} onClick={async () => {
      if (!window.confirm("Delete this scan permanently? You will need to scan it again.")) return;
      setBusy(true);
      try {
        await api(`/api/receipts/${receipt.id}`, { version: group.version }, "DELETE");
        select(false); await refresh(); report("Scan deleted. You can feed and scan the receipt again.");
      } catch (error) { report(String(error)); }
      finally { setBusy(false); }
    }}>Delete scan</button></p>}

    {receipt.state === "ready" && <button class="secondary" onClick={inspect}>{inspection ? "Close inspection" : "Inspect full-resolution strips & OCR"}</button>}
    {inspection && <section class="inspection">
      <div class="row"><button disabled={row === 0} onClick={() => setRow(Math.max(0, row - 512))}>Previous strip</button>
        <label>Starting row<input type="number" min="0" max={height - 1} value={row} onInput={event => setRow(Math.max(0, Math.min(height - 1, Number(event.currentTarget.value))))} /></label>
        <button disabled={row + 512 >= height} onClick={() => setRow(row + 512)}>Next strip</button>
        <button onClick={() => setRow(Math.max(0, height - 512))}>Physical bottom</button></div>
      <div class="strip"><img src={`/api/receipts/${receipt.id}/image?top=${row}`} alt={`Full-resolution rows ${row}–${Math.min(row + 512, height)}`} /></div>
      <details><summary>Unvalidated local OCR evidence</summary><pre>{JSON.stringify(evidence, null, 2)}</pre></details>
    </section>}
  </article>;
}

function GroupCard({ group, selected, select, refresh, report, driveConnected }: {
  group: Group; selected: Set<string>; select: (id: string, value: boolean) => void;
  refresh: () => Promise<void>; report: (value: string) => void; driveConnected: boolean;
}) {
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setReservation(null), [group.version]);
  async function act(callback: () => Promise<void>) {
    setBusy(true); try { await callback(); await refresh(); } catch (error) { report(String(error)); } finally { setBusy(false); }
  }
  async function move(index: number, delta: number) {
    const order = group.receipts.map(receipt => receipt.id);
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    await api("/api/groups/membership", { groups: { [group.id]: group.version }, receipt_ids: order });
  }
  return <section class="group" data-group-id={group.id}>
    <header><div><h2>{group.receipts[0]?.date || "Needs review"} <span class="muted">{group.receipts.length} page{group.receipts.length === 1 ? "" : "s"}</span></h2>
      <p><span class="badge">{group.state}</span> · version {group.version} · {group.manual ? "manual grouping" : "same-minute grouping"}</p></div>
      {group.state === "staging" && <button disabled={busy} onClick={() => act(async () => {
        const result = await api<Reservation>(`/api/groups/${group.id}/prepare`, { version: group.version }); setReservation(result);
      })}>Prepare approval</button>}</header>
    <div class="pages">{group.receipts.map((receipt, index) => <div key={receipt.id}>
      {group.state === "staging" && group.receipts.length > 1 && <div class="row"><span>Page {index + 1}</span>
        <button disabled={index === 0 || busy} onClick={() => act(() => move(index, -1))}>Move up</button>
        <button disabled={index === group.receipts.length - 1 || busy} onClick={() => act(() => move(index, 1))}>Move down</button></div>}
      <ReceiptEditor key={receipt.id} receipt={receipt} group={group} refresh={refresh} selected={selected.has(receipt.id)} select={value => select(receipt.id, value)} report={report} />
    </div>)}</div>
    {reservation && group.state === "staging" && <div class="approval"><p>Reserved export path: <strong>{reservation.path}</strong></p>
      {reservation.note && <p>{reservation.note}</p>}
      <p>Approval freezes these fields, page order and reference images.</p><button disabled={busy} onClick={() => act(async () => {
        await api(`/api/groups/${group.id}/approve`, { export_id: reservation.id, version: reservation.version }); setReservation(null);
        report("Approval queued. Originals remain until all approved artifacts are durable.");
      })}>Approve this version</button></div>}
    {group.exports.filter(item => item.state === "ready").map(item => <div class="approval" key={item.id}>
      <p><strong>{item.path}</strong></p><div class="row"><a class="button" href={`/api/exports/${item.id}/pdf`}>Download approved PDF</a>
        <button disabled={busy || !driveConnected || Boolean(item.drive_id)} onClick={() => act(async () => {
          await api(`/api/exports/${item.id}/drive`); report("Selected approved PDF queued for Drive delivery.");
        })}>{item.drive_id ? "Delivered to Drive" : "Send approved PDF to Drive"}</button></div></div>)}
  </section>;
}

function App() {
  const [state, setState] = useState<State>({ groups: [], jobs: [], drive: { configured: false, connected: false } });
  const [status, setStatus] = useState("Loading staging…");
  const [pending, setPending] = useState(0);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const memoryDiagnostics = useRef<Diagnostic[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [connected, setConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [longPaper, setLongPaper] = useState(true);
  const [languages, setLanguages] = useState(["eng"]);
  const [scanner, setScanner] = useState<any>(null);
  const [controller, setController] = useState<AbortController | null>(null);
  const [release, setRelease] = useState<(() => void) | null>(null);

  async function refresh() { setState(await api<State>("/api/state", undefined, "GET")); }
  async function localRefresh() { setPending(await database.pending.count()); setDiagnostics([...(await database.diagnostics.toArray()), ...memoryDiagnostics.current]); }
  async function resume() { await uploadPending(setStatus, () => { void localRefresh(); void refresh().catch(error => setStatus(String(error))); }); }
  useEffect(() => {
    void refresh().then(() => setStatus("Ready. Capture or review receipts.")).catch(error => setStatus(String(error)));
    void localRefresh().then(resume).catch(error => setStatus(`Browser storage unavailable: ${error}`));
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 3000);
    const retry = () => { void resume(); };
    window.addEventListener("online", retry);
    return () => { clearInterval(timer); window.removeEventListener("online", retry); };
  }, []);
  async function connect() {
    if (!isSecureContext || !navigator.usb || !crossOriginIsolated || !navigator.locks) {
      setStatus("Scanning needs desktop Chrome/Edge, HTTPS or localhost, WebUSB and cross-origin isolation."); return;
    }
    setConnecting(true);
    const ownership: { release?: () => void } = {};
    try {
      const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x04b8 }] });
      await new Promise<void>((resolve, reject) => {
        navigator.locks.request("receipt-sample-scanner", { ifAvailable: true }, async lock => {
          if (!lock) { reject(new Error("Another scanner/sample tab owns the device")); return; }
          await new Promise<void>(done => { ownership.release = done; resolve(); });
        }).catch(reject);
      });
      if (!window.LibSANE) await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script"); script.src = "/scanner-assets/libsane.js";
        script.onload = () => resolve(); script.onerror = () => reject(new Error("Patched scanner driver assets are unavailable"));
        document.head.append(script);
      });
      if (!window.LibSANE) throw new Error("Scanner driver did not initialize");
      if (!window.receiptSane) {
        window.receiptSane = await window.LibSANE({ locateFile: (path: string) => `${location.origin}/scanner-assets/${path}` });
        if (window.receiptSane.sane_init().status !== 0) throw new Error("Scanner initialization failed");
        window.receiptSane.RECEIPT_DRIVER_PROVENANCE = await (await fetch("/scanner-assets/provenance.json")).json();
      }
      const { createRawScanner } = await import(/* @vite-ignore */ "/raw-scanner.mjs");
      const capture = createRawScanner(window.receiptSane, { usb: { vendor_id: device.vendorId, product_id: device.productId } });
      const info = await capture.connect();
      setScanner(capture); setRelease(() => ownership.release ?? null); setConnected(true);
      setStatus(`${info.vendor} ${info.model} connected; ${window.receiptSane.RECEIPT_DRIVER_PROVENANCE.patch_revision}`);
      void navigator.storage.persist();
    } catch (error) { ownership.release?.(); setStatus(String(error)); }
    finally { setConnecting(false); }
  }
  async function disconnect() {
    try { await scanner.disconnect(); release?.(); setRelease(null); setConnected(false); setScanner(null); }
    catch (error) { setStatus(String(error)); }
  }
  async function enqueue(capture: ScannerCapture) {
    const id = crypto.randomUUID();
    const manifest: Manifest = { id, sha256: await sha256(capture.blob), byte_length: capture.blob.size, kind: "scanner-raw",
      width: capture.dimensions.width, height: capture.dimensions.height, frame: capture.scanner.parameters,
      dpi_x: capture.scanner.resolution.x, dpi_y: capture.scanner.resolution.y,
      transport_complete: capture.scanner.diagnostics.transport_complete, languages, scanner: capture.scanner };
    await database.pending.add({ id, created: Date.now(), blob: capture.blob, manifest });
    await localRefresh(); void resume();
  }
  async function scan() {
    const abort = new AbortController(); setController(abort); setScanning(true);
    let unsaved: ScannerCapture | null = null;
    try {
      await scanner.configure({ longPaper, maxLengthMm: 1200 });
      while (!abort.signal.aborted) {
        const capture = await scanner.capture({ signal: abort.signal, onPhase: (phase: string) => setStatus(`Scanner: ${phase}`) });
        if (capture) { unsaved = capture; await enqueue(capture); unsaved = null; setStatus("Capture retained locally; ready for the next receipt."); }
        else await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      const failure = error as Error & { capture?: ScannerCapture };
      const retained = failure.capture || unsaved;
      if (retained) {
        const diagnostic = { id: crypto.randomUUID(), blob: retained.blob, metadata: retained.scanner };
        try { await database.diagnostics.add(diagnostic); await localRefresh(); }
        catch { memoryDiagnostics.current.push(diagnostic); setDiagnostics(previous => [...previous, diagnostic]); setStatus("Browser storage failed. Download the retained bytes before closing this tab."); return; }
      }
      setStatus(failure.message || String(error));
    } finally { setScanning(false); setController(null); }
  }
  async function importImage(file: File) {
    try {
      const image = await createImageBitmap(file);
      const id = crypto.randomUUID();
      const manifest: Manifest = { id, kind: "image", sha256: await sha256(file), byte_length: file.size,
        width: image.width, height: image.height, dpi_x: 200, dpi_y: 200, transport_complete: true, languages };
      image.close(); await database.pending.add({ id, created: Date.now(), blob: file, manifest }); await localRefresh(); await resume();
    } catch (error) { setStatus(`Image import failed: ${error}`); }
  }
  async function combine() {
    try {
      const groups = Object.fromEntries(state.groups.filter(group => group.receipts.some(receipt => selected.has(receipt.id))).map(group => [group.id, group.version]));
      await api("/api/groups/membership", { groups, receipt_ids: [...selected] });
      setSelected(new Set()); await refresh(); setStatus("Selected pages combined/split in selection order. Manual grouping is retained.");
    } catch (error) { setStatus(String(error)); }
  }
  const groups = [...state.groups].sort((a, b) => {
    const priority = (group: Group) => group.state === "approved" ? 2 : group.receipts.some(r => !r.date || !r.time || !r.complete || !r.readable) ? 0 : 1;
    return priority(a) - priority(b);
  });
  return <main>
    <header class="title"><div><p class="eyebrow">RECEIPT WORKSPACE</p><h1>Capture. Review. Keep.</h1><p>Originals stay in staging until an approved PDF and its masters are durable.</p></div>
      <span class="badge">{state.groups.filter(group => group.state === "staging").length} staging groups</span></header>
    <section class="capture-panel"><h2>Scanner & transfer</h2><div class="row">
      <button onClick={connect} disabled={connected || connecting}>{connecting ? "Connecting…" : "Connect Epson scanner"}</button>
      <button onClick={scan} disabled={!connected || scanning}>Start session</button>
      <button onClick={() => { controller?.abort(); setStatus("Stop requested; waiting for the current driver operation."); }} disabled={!scanning}>Stop</button>
      <button class="secondary" onClick={disconnect} disabled={!connected || scanning}>Disconnect</button>
      <label class="check"><input type="checkbox" checked={longPaper} disabled={scanning} onChange={event => setLongPaper(event.currentTarget.checked)} /> Long-paper profile</label>
    </div><div class="row"><label>OCR languages<select multiple disabled={scanning} onChange={event => {
      const values = Array.from(event.currentTarget.selectedOptions, option => option.value); setLanguages(values.length ? values : ["eng"]);
    }}>{["eng", "fra", "jpn", "chi_tra", "chi_sim"].map(language => <option value={language} selected={languages.includes(language)}>{language}</option>)}</select></label>
      <label>Or import an unprocessed PNG (200 DPI)<input type="file" accept="image/png" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void importImage(file); event.currentTarget.value = ""; }} /></label>
      <div><strong>{pending} browser copies pending</strong><p><button class="secondary" onClick={resume}>Resume transfers</button></p></div></div>
      <p class="muted">Transport completion does not confirm the physical bottom. Check it during review. Local OCR is discovery evidence; dates and times are manually confirmed in this first slice.</p>
      {diagnostics.length > 0 && <details><summary>{diagnostics.length} incomplete/fault captures retained in this browser</summary>{diagnostics.map(item => <DiagnosticDownload item={item} key={item.id} />)}</details>}
    </section>
    <p class="status" role="status">{status}</p>
    <section class="toolbar"><div class="row"><button disabled={!selected.size} onClick={combine}>Make selected pages a manual group ({selected.size})</button>
      <button class="secondary" onClick={() => setSelected(new Set())}>Clear selection</button></div>
      <button disabled={connected || scanning || !state.drive.configured} onClick={async () => {
        try { const result = await api<{ url: string }>("/api/drive/connect"); location.assign(result.url); } catch (error) { setStatus(String(error)); }
      }}>{state.drive.connected ? "Reconnect Drive" : "Connect Google Drive"}</button>
    </section>
    {!state.drive.configured && <p class="muted">Drive is optional until OAuth credentials and the existing receipts root are configured. Approved PDFs remain downloadable.</p>}
    {groups.map(group => <GroupCard key={group.id} group={group} selected={selected} select={(id, value) => setSelected(previous => {
      const next = new Set(previous); value ? next.add(id) : next.delete(id); return next;
    })} refresh={refresh} report={setStatus} driveConnected={state.drive.connected} />)}
    {!groups.length && <section class="empty"><h2>Your staging area is ready</h2><p>Connect the scanner or import an unprocessed image to begin.</p></section>}
    <details class="jobs"><summary>Background jobs ({state.jobs.filter(job => !["done"].includes(job.state)).length} pending/failed)</summary>
      {state.jobs.map(job => <p key={job.id}><code>{job.kind} · {job.target.slice(0, 8)}</code> — {job.state}{job.error && `: ${job.error}`} {job.state === "failed" && <button onClick={async () => {
        try { await api(`/api/jobs/${job.id}/retry`); await refresh(); } catch (error) { setStatus(String(error)); }
      }}>Retry</button>}</p>)}</details>
  </main>;
}

function DiagnosticDownload({ item }: { item: Diagnostic }) {
  const [raw, setRaw] = useState(""); const [metadata, setMetadata] = useState("");
  useEffect(() => {
    const a = URL.createObjectURL(item.blob); const b = URL.createObjectURL(new Blob([JSON.stringify(item.metadata, null, 2)], { type: "application/json" }));
    setRaw(a); setMetadata(b); return () => { URL.revokeObjectURL(a); URL.revokeObjectURL(b); };
  }, [item.id]);
  return <p><code>{item.id.slice(0, 8)}</code> · {item.blob.size} bytes · <a href={raw} download={`${item.id}-partial.bin`}>Partial bytes</a> · <a href={metadata} download={`${item.id}-diagnostics.json`}>Diagnostics</a></p>;
}

render(<App />, document.getElementById("app")!);
