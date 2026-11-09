import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import Dexie, { type Table } from "dexie";
import "./style.css";
import "./evidence.css";

type Frame = { format: number; depth: number; bytes_per_line: number; pixels_per_line: number; lines: number; last_frame: boolean };
type ScannerCapture = { blob: Blob; dimensions: { width: number; height: number }; scanner: {
  parameters: Frame; resolution: { x: number; y: number }; diagnostics: { transport_complete: boolean }; [key: string]: unknown } };
type Manifest = { id: string; kind: "scanner-raw" | "image"; sha256: string; byte_length: number;
  width: number; height: number; dpi_x: number; dpi_y: number; transport_complete: boolean;
  languages: string[]; frame?: Frame; scanner?: Record<string, unknown>;
  timestamp_policy?: { century: number | null; expected_month: string | null } };
type Pending = { id: string; created: number; blob: Blob; manifest: Manifest };
type Diagnostic = { id: string; blob: Blob; metadata: unknown };
type Receipt = { id: string; group_id: string; date: string | null; time: string | null; state: string;
  complete: number; readable: number; complete_source: string | null; readable_source: string | null;
  vendor: string | null; error: string | null; languages: string[];
  field_source: "manual" | "ocr" | "unresolved" | "confirmed"; timestamp_review: number; analysis?: AnalysisRun | null };
type AnalysisRun = { id: string; version: number; mode: string; state: string; error: string | null; has_evidence: boolean;
  policy: { requested: { date_order: string | null; century: string | number | null; expected_month?: string | null };
    effective: { date_order: string | null; century: number | null; expected_month?: string | null }; source: string } };
type Candidate = { id: string; dates: string[]; time: string | null; issues: string[];
  sources: { text: string; box: number[]; ocr_confidence: number; pass: string }[] };
type Extraction = { version: string; status: string; issues: string[]; selected: { date: string; time: string } | null; candidates: Candidate[];
  routing?: { selected_engine: string | null; primary_issues: string[] } };
type FallbackInfo = { state: string; reason: string | null; seconds: number };
type Export = { id: string; path: string; state: string; drive_id: string | null };
type Group = { id: string; version: number; state: string; manual: number; receipts: Receipt[]; exports: Export[] };
type Job = { id: string; kind: string; target: string; state: string; attempts: number; error: string | null };
type State = { groups: Group[]; jobs: Job[]; drive: { configured: boolean; connected: boolean } };
type Reservation = { id: string; path: string; version: number; note?: string | null };

type Reason = { code: string; label: string; short: string; hard: boolean };

// Every label names the operator's next move, not the symptom, and FIX_RANK orders them by how
// much judgment the fix needs: an unresolved date outranks a checkbox, so the primary fix shown
// in a ledger cell is always the most expensive thing standing between the group and approval.
// `short` is the same instruction at ledger width; the row's action button supplies the verb and
// its tooltip plus the status line give the full sentence.
const FIX_RANK: Record<string, number> = { error: 0, processing: 1, timestamp: 2, "analysis-failed": 3, incomplete: 4, unreadable: 5, analyzing: 6, proposal: 7 };

function receiptIssues(receipt: Receipt): Reason[] {
  const issues: Reason[] = [];
  if (receipt.error) issues.push({ code: "error", label: "scan error", short: "error", hard: true });
  if (receipt.state !== "ready") issues.push({ code: "processing", label: "scan pending", short: "scanning", hard: true });
  if (!receipt.date || !receipt.time) issues.push({ code: "timestamp", label: receipt.date ? "set time" : "set date", short: receipt.date ? "time" : "date", hard: true });
  if (receipt.analysis?.state === "failed") issues.push({ code: "analysis-failed", label: "retry analysis", short: "retry", hard: true });
  if (!receipt.complete) issues.push({ code: "incomplete", label: "attest bottom", short: "bottom", hard: true });
  if (!receipt.readable) issues.push({ code: "unreadable", label: "attest legible", short: "legible", hard: true });
  if (["queued", "running"].includes(receipt.analysis?.state ?? "")) issues.push({ code: "analyzing", label: "OCR running", short: "OCR", hard: false });
  if (receipt.timestamp_review && !issues.some(issue => issue.hard)) issues.push({ code: "proposal", label: "confirm date", short: "confirm", hard: false });
  return issues;
}

function groupSeverity(group: Group): "blocked" | "pending" | "clear" {
  if (group.state === "approval_failed") return "blocked";
  const issues = group.receipts.flatMap(receiptIssues);
  if (issues.some(issue => issue.hard)) return "blocked";
  return issues.length ? "pending" : "clear";
}

// Glyph plus tint plus border: severity must survive greyscale and colour-blind viewing.
const SEVERITY_GLYPH = { blocked: "▲", pending: "●", clear: "✓" };

function groupIssues(group: Group): { code: string; label: string; short: string; count: number; hard: boolean }[] {
  const counts = new Map<string, { label: string; short: string; count: number; hard: boolean }>();
  for (const receipt of group.receipts) for (const issue of receiptIssues(receipt)) {
    const current = counts.get(issue.code);
    counts.set(issue.code, current ? { ...current, count: current.count + 1, hard: current.hard || issue.hard }
      : { label: issue.label, short: issue.short, count: 1, hard: issue.hard });
  }
  return [...counts].map(([code, meta]) => ({ code, ...meta }))
    .sort((a, b) => (FIX_RANK[a.code] ?? 9) - (FIX_RANK[b.code] ?? 9) || b.count - a.count);
}

// A group is named by its own data, never by its status: the tab already says "review".
function groupTitle(group: Group) {
  const dates = group.receipts.map(receipt => receipt.date).filter(Boolean).sort();
  return dates[0] || `#${group.id.slice(0, 8)}`;
}

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

function ReceiptEditor({ receipt, group, refresh, selected, select, report, onDirty }: {
  receipt: Receipt; group: Group; refresh: () => Promise<void>; selected: boolean;
  select: (value: boolean) => void; report: (value: string) => void;
  onDirty: (id: string, dirty: boolean) => void;
}) {
  const [date, setDate] = useState(receipt.date ?? "");
  const [clock, setClock] = useState(receipt.time ?? "");
  const [vendor, setVendor] = useState(receipt.vendor ?? "");
  const [complete, setComplete] = useState(Boolean(receipt.complete));
  const [readable, setReadable] = useState(Boolean(receipt.readable));
  const inspectionRef = useRef<HTMLDialogElement>(null);
  const [row, setRow] = useState(0);
  const [height, setHeight] = useState(512);
  const [evidence, setEvidence] = useState<unknown>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [fallbackInfo, setFallbackInfo] = useState<FallbackInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [baseVersion, setBaseVersion] = useState(group.version);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirty(receipt.id, dirty); }, [receipt.id, dirty, onDirty]);
  useEffect(() => () => onDirty(receipt.id, false), [receipt.id, onDirty]);
  const stale = baseVersion !== group.version;
  function showInspection() { inspectionRef.current?.showModal(); }
  useEffect(() => {
    if (receipt.state !== "ready") return;
    if (!dirty && (!receipt.analysis || ["ready", "failed"].includes(receipt.analysis.state))) {
      setBaseVersion(group.version); setDate(receipt.date ?? ""); setClock(receipt.time ?? "");
      setVendor(receipt.vendor ?? ""); setComplete(Boolean(receipt.complete)); setReadable(Boolean(receipt.readable));
    }
    // The dependency on field_source re-syncs the local boxes after batch confirmation changes server flags.
    let active = true;
    void api<{ capture: { height: number }; processing: { extraction?: Extraction; ocr?: { fallback?: FallbackInfo } } | null }>(`/api/receipts/${receipt.id}/evidence`, undefined, "GET").then(result => {
      if (!active) return;
      setHeight(result.capture.height); setEvidence(result.processing); setExtraction(result.processing?.extraction ?? null);
      setFallbackInfo(result.processing?.ocr?.fallback ?? null);
    }).catch(error => report(String(error)));
    return () => { active = false; };
  }, [receipt.state, receipt.analysis?.id, receipt.analysis?.state, receipt.field_source]);
  const editable = group.state === "staging" && receipt.state === "ready";
  async function inspect() {
    try {
      const result = await api<{ capture: { height: number }; processing: unknown }>(`/api/receipts/${receipt.id}/evidence`, undefined, "GET");
      setHeight(result.capture.height); setEvidence(result.processing); showInspection();
    } catch (error) { report(String(error)); }
  }
  return <article class="receipt">
    <header class="row"><label><input type="checkbox" checked={selected} disabled={group.state !== "staging"}
      onChange={event => select(event.currentTarget.checked)} /> Select page <code>{receipt.id.slice(0, 8)}</code></label>
      <span class="badge">{receipt.state}</span></header>
    {receipt.state === "ready" && <img class="thumbnail" src={`/api/receipts/${receipt.id}/image`} alt={`Receipt ${receipt.id.slice(0, 8)} preview`} loading="lazy" onClick={inspect} />}
    {extraction && <section class="proposal"><strong>{extraction.selected ? "OCR timestamp proposal — confirm against the scan" : "Timestamp needs manual review"}</strong>
      {extraction.routing?.selected_engine === "rapidocr" && <p>RapidOCR fallback supplied this proposal. Inspect both engine source lists.</p>}
      {extraction.routing?.primary_issues.length ? <p class="muted">Primary OCR: {extraction.routing.primary_issues.map(issue => issue.replaceAll("_", " ")).join(" · ")}</p> : null}
      {fallbackInfo && fallbackInfo.reason !== "primary_supported" && <p class="muted">Fallback: {fallbackInfo.state.replaceAll("_", " ")} · {fallbackInfo.seconds.toFixed(1)} seconds{fallbackInfo.reason ? ` · ${fallbackInfo.reason.replaceAll("_", " ")}` : ""}</p>}
      {receipt.field_source === "manual" && <p>Your saved fields take priority over the OCR proposal.</p>}
      {receipt.field_source === "confirmed" && <p class="muted">Batch confirmation accepted the stored proposal and attested this page. Manual review stays available.</p>}
      {extraction.issues.length > 0 && <p class="muted">{extraction.issues.map(issue => issue.replaceAll("_", " ")).join(" · ")}</p>}
      <details><summary>Timestamp candidates & source regions ({extraction.candidates.length})</summary>
        {extraction.candidates.map(candidate => <div class="candidate" key={candidate.id}>
          <p><code>{candidate.dates.join(" or ") || "Unresolved date"} {candidate.time || "Invalid time"}</code></p>
          {candidate.issues.length > 0 && <p class="muted">{candidate.issues.map(issue => issue.replaceAll("_", " ")).join(" · ")}</p>}
          {candidate.sources.map((source, index) => <div key={index}><pre>{source.text}</pre>
            <button class="secondary" onClick={() => { setRow(Math.max(0, Math.min(height - 1, source.box[1] - 24))); showInspection(); }}>Inspect source at row {source.box[1]}</button>
          </div>)}
        </div>)}
      </details>
      {extraction.selected && editable && <button class="secondary" onClick={() => {
        setDate(extraction.selected!.date); setClock(extraction.selected!.time); setDirty(true);
      }}>Use proposed timestamp</button>}
    </section>}
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true);
      try { const saved = await api<{ version: number }>(`/api/receipts/${receipt.id}`, { version: baseVersion, date: date || null, time: clock || null,
        vendor: vendor || null, complete, readable }); await refresh(); setBaseVersion(saved.version); setDirty(false); report("Review saved. Same-minute staging groups updated."); }
      catch (error) { report(String(error)); } finally { setBusy(false); }
    }}>
      <fieldset disabled={!editable || busy || stale}>
        <div class="field-grid">
          <label>Transaction date<input type="date" value={date} onInput={event => { setDate(event.currentTarget.value); setDirty(true); }} /></label>
          <label>Transaction time<input type="time" step="1" value={clock} onInput={event => { setClock(event.currentTarget.value); setDirty(true); }} /></label>
          <label>Vendor hint (optional)<input value={vendor} maxLength={200} onInput={event => { setVendor(event.currentTarget.value); setDirty(true); }} /></label>
        </div>
        <div class="field-actions">
          <label class="check"><input type="checkbox" checked={complete} onChange={event => { setComplete(event.currentTarget.checked); setDirty(true); }} /> Physical bottom is present</label>
          <label class="check"><input type="checkbox" checked={readable} onChange={event => { setReadable(event.currentTarget.checked); setDirty(true); }} /> Selected image is readable</label>
          <button type="submit">Save review</button>
        </div>
        {receipt.complete_source === "transport" && <p class="proof">The scanner's end-of-page report carried this page through whole: the bottom flag is measured, not judged. You still own legibility.</p>}
        {receipt.complete_source === "operator" && <p class="proof">An earlier review already attested this page's physical bottom and legibility.</p>}
        {receipt.readable_source === "ocr" && <p class="proof">Recognition read this page densely and confidently, so legibility was auto-checked rather than assumed. If the image disagrees, untick it — a machine never overrules your judgement.</p>}
      </fieldset>
    </form>
    {receipt.state === "ready" && <AnalysisControls receipt={receipt} group={group} refresh={refresh} report={report} />}
    {stale && editable && <p role="alert">This group changed. <button class="secondary" onClick={() => {
      setDate(receipt.date ?? ""); setClock(receipt.time ?? ""); setVendor(receipt.vendor ?? "");
      setComplete(Boolean(receipt.complete)); setReadable(Boolean(receipt.readable)); setBaseVersion(group.version); setDirty(false);
    }}>Reload latest review</button> <button class="secondary" onClick={() => setBaseVersion(group.version)}>Keep local edits</button>
      <span class="muted"> Server timestamp: {receipt.date || "unresolved"} {receipt.time || "unresolved"}</span></p>}
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

    {receipt.state === "ready" && <button class="secondary" onClick={inspect}>Inspect full-resolution strips & OCR</button>}
    <dialog class="inspection" ref={inspectionRef} aria-modal="true" aria-label={`Full-resolution inspection for receipt ${receipt.id.slice(0, 8)}`}
      onClick={event => { if (event.target === event.currentTarget) inspectionRef.current?.close(); }}>
      <section class="inspection-modal">
        <header class="inspection-head"><h2>Full-resolution strips & OCR <span class="muted">page <code>{receipt.id.slice(0, 8)}</code></span></h2>
          <button class="secondary" autofocus onClick={() => inspectionRef.current?.close()}>Close inspection</button></header>
        <div class="row"><button disabled={row === 0} onClick={() => setRow(Math.max(0, row - 512))}>Previous strip</button>
          <label>Starting row<input type="number" min="0" max={height - 1} value={row} onInput={event => setRow(Math.max(0, Math.min(height - 1, Number(event.currentTarget.value))))} /></label>
          <button disabled={row + 512 >= height} onClick={() => setRow(row + 512)}>Next strip</button>
          <button onClick={() => setRow(Math.max(0, height - 512))}>Physical bottom</button></div>
        <div class="strip"><img src={`/api/receipts/${receipt.id}/image?top=${row}`} alt={`Full-resolution rows ${row}–${Math.min(row + 512, height)}`} /></div>
        <details><summary>Unvalidated local OCR evidence</summary><pre>{JSON.stringify(evidence, null, 2)}</pre></details>
      </section>
    </dialog>
  </article>;
}

function AnalysisControls({ receipt, group, refresh, report }: { receipt: Receipt; group: Group; refresh: () => Promise<void>; report: (value: string) => void }) {
  const [order, setOrder] = useState("inherit"); const [century, setCentury] = useState("inherit");
  const [busy, setBusy] = useState(false); const [history, setHistory] = useState<AnalysisRun[]>([]);
  const [oldEvidence, setOldEvidence] = useState<unknown>(null);
  useEffect(() => {
    const requested = receipt.analysis?.policy.requested;
    setOrder(requested?.date_order === null ? "unknown" : requested?.date_order ?? "inherit");
    setCentury(requested?.century === null ? "unknown" : String(requested?.century ?? "inherit"));
  }, [receipt.analysis?.id]);
  async function request(mode: "parse" | "ocr") {
    setBusy(true);
    try {
      await api(`/api/receipts/${receipt.id}/analyze`, { version: group.version, mode,
        date_order: order === "unknown" ? null : order, century: century === "unknown" ? null : century === "inherit" ? "inherit" : Number(century) });
      await refresh(); setHistory([]); setOldEvidence(null); report("Analysis queued with this receipt's explicit convention. Review the result before approval.");
    } catch (error) { report(String(error)); } finally { setBusy(false); }
  }
  return <section class="analysis-controls">
    {group.state === "staging" && <details><summary>Date convention & reprocess</summary>
      <p class="muted">These choices apply only to this receipt. They do not confirm its timestamp or change other receipts.</p>
      <fieldset disabled={busy}>
        <label>Numeric date order<select aria-label="Numeric date order" value={order} onChange={event => setOrder(event.currentTarget.value)}>
          <option value="inherit">Use application default</option><option value="unknown">No assumption</option>
          <option value="MDY">Month / day / year</option><option value="DMY">Day / month / year</option><option value="YMD">Year / month / day</option>
        </select></label>
        <label>Two-digit year century<select aria-label="Two-digit year century" value={century} onChange={event => setCentury(event.currentTarget.value)}>
          <option value="inherit">Use application default</option><option value="unknown">No assumption</option>
          <option value="1900">1900–1999</option><option value="2000">2000–2099</option>
        </select></label>
        <div class="row"><button onClick={() => request("parse")}>Apply convention to saved OCR</button>
          <button class="secondary" onClick={() => request("ocr")}>Run OCR again</button></div>
      </fieldset>
    </details>}
    {receipt.analysis && <p class="muted">Analysis {receipt.analysis.version}: {receipt.analysis.state} · {receipt.analysis.mode} · effective order {receipt.analysis.policy.effective.date_order || "unresolved"}, century {receipt.analysis.policy.effective.century ?? "unresolved"}{receipt.analysis.policy.effective.expected_month ? `, expected month ${receipt.analysis.policy.effective.expected_month}` : ""}{receipt.analysis.error ? ` · ${receipt.analysis.error}` : ""}</p>}
    <details onToggle={async event => {
      if (!event.currentTarget.open) return;
      try { const result = await api<{ analyses: AnalysisRun[] }>(`/api/receipts/${receipt.id}/analyses`, undefined, "GET"); setHistory(result.analyses); }
      catch (error) { report(String(error)); }
    }}><summary>Analysis history</summary>
      {history.map(run => <p key={run.id}>Version {run.version}: {run.state} · {run.mode} <button class="secondary" disabled={!run.has_evidence} onClick={async () => {
        try { setOldEvidence(await api(`/api/receipts/${receipt.id}/evidence?analysis_id=${run.id}`, undefined, "GET")); }
        catch (error) { report(String(error)); }
      }}>Inspect analysis {run.version}</button></p>)}
      {oldEvidence !== null && <pre>{JSON.stringify(oldEvidence, null, 2)}</pre>}
    </details>
  </section>;
}

function ReceiptChip({ receipt, selectable, isSelected, onSelect }: {
  receipt: Receipt; selectable: boolean; isSelected?: boolean; onSelect?: (value: boolean) => void;
}) {
  const issues = receiptIssues(receipt);
  const severity = issues.some(issue => issue.hard) ? "blocked" : issues.length ? "pending" : "clear";
  return <div class="receipt-chip" data-severity={severity}>
    {selectable && <input type="checkbox" checked={Boolean(isSelected)}
      onChange={event => onSelect?.(event.currentTarget.checked)} aria-label={`Select page ${receipt.id.slice(0, 8)}`} />}
    <a class="chip-thumb" href={`/api/receipts/${receipt.id}/image`} target="_blank" rel="noreferrer" title="Open full page">
      <img src={`/api/receipts/${receipt.id}/image`} alt={`Receipt ${receipt.id.slice(0, 8)} thumbnail`} loading="lazy" /></a>
    <code>{receipt.id.slice(0, 8)}</code>
    <span class="stamp">{receipt.date || "no date"}{receipt.time ? ` ${receipt.time}` : ""}</span>
    {issues.map(issue => <span class={`pill ${issue.hard ? "bad" : issue.code === "analyzing" ? "working" : "warn"}`} key={issue.code}>{issue.label}</span>)}
    {!issues.length && <span class="pill ok">ready</span>}
  </div>;
}

function isInstantlyApprovable(group: Group) {
  return group.state === "staging" && group.receipts.length > 0 && group.receipts.every(receipt =>
    receipt.state === "ready" && receipt.date && receipt.time && !receipt.error && !receipt.timestamp_review
    && receipt.field_source === "confirmed" && Boolean(receipt.complete) && Boolean(receipt.readable)
    && !["queued", "running"].includes(receipt.analysis?.state ?? "ready"));
}

// A row's single inline action, derived from the top-ranked issue so the button always names the
// most expensive thing standing between this group and approval. Null means the fix needs judgment,
// so the cell offers no button: opening the editor is the honest answer.
type Fix = { kind: "confirm" | "attest" | "approve" | "retry"; hint: string; count: number } | null;

function failedApproveJob(group: Group, jobs: Job[]) {
  const exports = new Set(group.exports.map(item => item.id));
  return jobs.find(job => job.state === "failed" && job.kind === "approve" && exports.has(job.target)) ?? null;
}

function primaryFix(group: Group, jobs: Job[], confirmIds: Set<string>, approveIds: Set<string>): Fix {
  if (group.state === "approval_failed") {
    const job = failedApproveJob(group, jobs);
    return job ? { kind: "retry", hint: `Retry the failed approval for ${groupTitle(group)}`, count: 1 } : null;
  }
  const reviewing = group.receipts.filter(receipt => receipt.timestamp_review === 1).length;
  const unattested = group.receipts.filter(receipt => !receipt.complete || !receipt.readable).length;
  switch (groupIssues(group)[0]?.code) {
    case undefined:
      return approveIds.has(group.id) ? { kind: "approve", hint: `Approve ${groupTitle(group)}`, count: 1 } : null;
    case "proposal":
      return confirmIds.has(group.id) ? { kind: "confirm", hint: `Confirm ${reviewing} stored proposal${reviewing === 1 ? "" : "s"} in ${groupTitle(group)}`, count: reviewing } : null;
    case "incomplete":
    case "unreadable":
      // One Confirm call sets both flags and clears the review in a single UPDATE (api.py:313).
      // When every unattested page still carries its stored proposal, Confirm clears everything,
      // and attest would only be a slower way to do the same work - then fall back to attest,
      // which the endpoint can reach even for pages whose proposal was replaced by hand.
      if (confirmIds.has(group.id) && group.receipts.every(receipt => (receipt.complete && receipt.readable) || receipt.timestamp_review === 1))
        return { kind: "confirm", hint: `Confirm ${reviewing} stored proposal${reviewing === 1 ? "" : "s"} in ${groupTitle(group)} — also attests bottom and legibility`, count: reviewing };
      return { kind: "attest", hint: `Attest bottom and legibility for ${unattested} page${unattested === 1 ? "" : "s"} in ${groupTitle(group)}`, count: unattested };
    default:
      return null;
  }
}

// One ledger cell: fixed height, never wraps, and carries the one action that needs no dialog.
function LedgerCell({ group, index, fix, focused, busy, edit, act }: {
  group: Group; index: number; fix: Fix; focused: boolean; busy: boolean; edit: () => void; act: () => Promise<void>;
}) {
  const title = groupTitle(group);
  const chips = (group.state === "approval_failed" ? [{ code: "approval-failed", label: "approval failed", short: "failed", count: 1, hard: true }] : [])
    .concat(groupIssues(group));
  const working = chips.length > 0 && chips.every(chip => chip.code === "analyzing");
  return <section class="cell" data-group-id={group.id} data-ledger-index={index} data-severity={groupSeverity(group)}
    data-focused={focused || undefined} title={`${title} · version ${group.version} · ${group.manual ? "manual grouping" : "same-minute grouping"} · ${
      chips.map(chip => `${chip.label}${chip.count > 1 ? ` ×${chip.count}` : ""}`).join(" · ") || "no open issues"}`}>
    <span class={`glyph${working ? " working" : ""}`} aria-hidden="true">{SEVERITY_GLYPH[groupSeverity(group)]}</span>
    <button class="ident" aria-haspopup="dialog" aria-label={`Edit group ${title}`} onClick={edit}>
      {title} <em>{group.receipts.length}p</em></button>
    <span class="fixes">{chips.slice(0, 2).map(chip => <span class={`pill ${chip.hard ? "bad" : "warn"}`} key={chip.code}>
      {chip.short}{chip.count > 1 ? ` ×${chip.count}` : ""}</span>)}
      {chips.length > 2 && <span class="pill more">+{chips.length - 2}</span>}</span>
    {fix && <button class={`act ${fix.kind}`} disabled={busy} onClick={act} aria-label={fix.hint} title={fix.hint}>
      ⏎{fix.count > 1 ? fix.count : ""}</button>}
  </section>;
}

function GroupEditor({ group, selected, select, refresh, report, close, focusDate }: {
  group: Group; selected: Set<string>; select: (id: string, value: boolean) => void;
  refresh: () => Promise<void>; report: (value: string) => void; close: () => void; focusDate: boolean;
}) {
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirtyPages, setDirtyPages] = useState(new Set<string>());
  const dialogRef = useRef<HTMLDialogElement>(null);
  const flagDirty = useCallback((id: string, dirty: boolean) => setDirtyPages(previous => {
    if (previous.has(id) === dirty) return previous;
    const next = new Set(previous); dirty ? next.add(id) : next.delete(id); return next;
  }), []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    if (focusDate) dialog.querySelector<HTMLElement>(".field-grid input[type=\"date\"]")?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  useEffect(() => setReservation(null), [group.version]);
  const instantlyApprovable = isInstantlyApprovable(group);
  async function act(callback: () => Promise<void>) {
    setBusy(true); try { await callback(); await refresh(); } catch (error) { report(String(error)); } finally { setBusy(false); }
  }
  function approveNow() {
    return act(async () => {
      const reservation = await api<Reservation>(`/api/groups/${group.id}/prepare`, { version: group.version });
      await api(`/api/groups/${group.id}/approve`, { export_id: reservation.id, version: reservation.version });
      close();
      report("Approval queued. Originals remain until all approved artifacts are durable.");
    });
  }
  async function move(index: number, delta: number) {
    const order = group.receipts.map(receipt => receipt.id);
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    await api("/api/groups/membership", { groups: { [group.id]: group.version }, receipt_ids: order });
  }
  function prepareReservation() {
    return act(async () => {
      const result = await api<Reservation>(`/api/groups/${group.id}/prepare`, { version: group.version }); setReservation(result);
    });
  }
  const title = groupTitle(group);
  return <dialog class="editor" ref={dialogRef} aria-label={`Review group ${title}`} onClose={close}
    onClick={event => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}>
    <header class="editor-head"><div><h2>{title} <span class="muted">{group.receipts.length} page{group.receipts.length === 1 ? "" : "s"}</span></h2>
      <p><span class="badge">{group.state.replaceAll("_", " ")}</span> · version {group.version} · {group.manual ? "manual grouping" : "same-minute grouping"}</p>
      {group.state === "approval_failed" && <p class="muted">Approval failed. Retry its approve job from the row's action, or from the Jobs tab.</p>}</div>
      <div class="row">{instantlyApprovable && <button disabled={busy || dirtyPages.size > 0} onClick={approveNow}>Approve</button>}
        {group.state === "staging" && !instantlyApprovable && <button disabled={busy || dirtyPages.size > 0} onClick={prepareReservation}>Prepare approval</button>}
        <button class="secondary" onClick={() => dialogRef.current?.close()}>Close</button></div></header>
    <div class="pages">{group.receipts.map((receipt, index) => <div key={receipt.id}>
      {group.state === "staging" && group.receipts.length > 1 && <div class="row"><span>Page {index + 1}</span>
        <button disabled={index === 0 || busy} onClick={() => act(() => move(index, -1))}>Move up</button>
        <button disabled={index === group.receipts.length - 1 || busy} onClick={() => act(() => move(index, 1))}>Move down</button></div>}
      <ReceiptEditor key={receipt.id} receipt={receipt} group={group} refresh={refresh} selected={selected.has(receipt.id)} select={value => select(receipt.id, value)} report={report} onDirty={flagDirty} />
    </div>)}</div>
    {dirtyPages.size > 0 && <p class="muted">Save or reload local field edits before approval.</p>}
    {reservation && group.state === "staging" && <div class="approval"><p>Reserved export path: <strong>{reservation.path}</strong></p>
      {reservation.note && <p>{reservation.note}</p>}
      <p>Approval freezes these fields, page order and reference images.</p><button disabled={busy || dirtyPages.size > 0} onClick={() => act(async () => {
        await api(`/api/groups/${group.id}/approve`, { export_id: reservation.id, version: reservation.version }); setReservation(null);
        dialogRef.current?.close();
        report("Approval queued. Originals remain until all approved artifacts are durable.");
      })}>Approve this version</button></div>}
  </dialog>;
}

function App() {
  const [state, setState] = useState<State>({ groups: [], jobs: [], drive: { configured: false, connected: false } });
  const [status, setStatus] = useState("Loading staging…");
  const [pending, setPending] = useState(0);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const memoryDiagnostics = useRef<Diagnostic[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [longPaper, setLongPaper] = useState(true);
  const [languages, setLanguages] = useState(["eng"]);
  const [scanCentury, setScanCentury] = useState(() => {
    try { const saved = localStorage.getItem("receipt-scan-century"); return ["current", "1900", "none"].includes(saved ?? "") ? saved! : "current"; }
    catch { return "current"; }
  });
  const lastMonth = (() => { const day = new Date(); day.setDate(1); day.setMonth(day.getMonth() - 1);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}`; })();
  const [expectedMonth, setExpectedMonth] = useState(() => {
    try { const saved = localStorage.getItem("receipt-expected-month");
      if (saved === null) return lastMonth;
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(saved) ? saved : ""; }
    catch { return lastMonth; }
  });
  const [tab, setTab] = useState<"review" | "exports" | "jobs">(() => {
    try { const saved = localStorage.getItem("receipt-workspace-tab"); return ["review", "exports", "jobs"].includes(saved ?? "") ? saved as "review" | "exports" | "jobs" : "review"; }
    catch { return "review"; }
  });
  function showTab(value: "review" | "exports" | "jobs") {
    setTab(value);
    try { localStorage.setItem("receipt-workspace-tab", value); } catch { /* the choice applies to this visit */ }
  }
  const [sendingExport, setSendingExport] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [busyGroups, setBusyGroups] = useState(new Set<string>());
  const [ledgerStage, setLedgerStage] = useState<"all" | "attention" | "confirm" | "approve">("all");
  const [cursor, setCursor] = useState<number | null>(null);
  const [focusDate, setFocusDate] = useState(false);
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
      transport_complete: capture.scanner.diagnostics.transport_complete, languages, scanner: capture.scanner,
      timestamp_policy: scanPolicy() };
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
    const policy = scanPolicy();
    try {
      const image = await createImageBitmap(file);
      const id = crypto.randomUUID();
      const manifest: Manifest = { id, kind: "image", sha256: await sha256(file), byte_length: file.size,
        width: image.width, height: image.height, dpi_x: 200, dpi_y: 200, transport_complete: true, languages, timestamp_policy: policy };
      image.close(); await database.pending.add({ id, created: Date.now(), blob: file, manifest }); await localRefresh(); await resume();
    } catch (error) { setStatus(`Image import failed: ${error}`); }
  }
  function scanPolicy() {
    return { century: scanCentury === "none" ? null : scanCentury === "current" ? Math.floor(new Date().getFullYear() / 100) * 100 : Number(scanCentury),
      expected_month: /^\d{4}-(0[1-9]|1[0-2])$/.test(expectedMonth) ? expectedMonth : null };
  }
  async function combine() {
    try {
      const groups = Object.fromEntries(state.groups.filter(group => group.receipts.some(receipt => selected.has(receipt.id))).map(group => [group.id, group.version]));
      await api("/api/groups/membership", { groups, receipt_ids: [...selected] });
      setSelected(new Set()); await refresh(); setStatus("Selected pages combined/split in selection order. Manual grouping is retained.");
    } catch (error) { setStatus(String(error)); }
  }
  const exportsReady = state.groups.flatMap(group => group.exports.filter(item => item.state === "ready"));
  const undelivered = exportsReady.filter(item => !item.drive_id);
  const activeJobs = state.jobs.filter(job => !["done"].includes(job.state));
  const reviewGroups = state.groups.filter(group => ["staging", "approval_failed"].includes(group.state));
  const attentionGroups = reviewGroups.filter(group => groupSeverity(group) === "blocked"
    || group.receipts.some(receipt => ["queued", "running"].includes(receipt.analysis?.state ?? "")));
  const attentionIds = new Set(attentionGroups.map(group => group.id));
  const quickEligible = (group: Group) => group.state === "staging" && group.receipts.length > 0 && group.receipts.every(receipt =>
    receipt.state === "ready" && receipt.date && receipt.time && !receipt.error && !["queued", "running"].includes(receipt.analysis?.state ?? "ready"));
  const confirmGroups = reviewGroups.filter(group => quickEligible(group) && group.receipts.some(receipt => receipt.timestamp_review === 1));
  const approveGroups = reviewGroups.filter(group => quickEligible(group) && group.receipts.every(receipt =>
    !receipt.timestamp_review && receipt.field_source === "confirmed" && Boolean(receipt.complete) && Boolean(receipt.readable)));
  const confirmBucket = confirmGroups.filter(group => !attentionIds.has(group.id));
  // One-call Confirm eligibility, at the server's full scope: confirm-proposed attests bottom and
  // legibility too, so an attention-flagged group whose pages still hold their proposals belongs
  // here even though the display bucket keeps them under "fix".
  const confirmIds = new Set(confirmGroups.map(group => group.id));
  const approveBucket = reviewGroups.filter(group => !attentionIds.has(group.id) && !confirmIds.has(group.id));
  const finalizingGroups = state.groups.filter(group => group.state === "finalizing");
  const approvedGroups = state.groups.filter(group => group.state === "approved");
  const confirmPages = confirmGroups.reduce((total, group) => total + group.receipts.filter(receipt => receipt.timestamp_review === 1).length, 0);
  const editingGroup = editingId ? state.groups.find(group => group.id === editingId) : undefined;
  const approveIds = new Set(approveGroups.map(group => group.id));
  // The three locked buckets stop being sections and become the ledger's sort order plus its filters.
  // Undated groups lead the queue (they need the most judgment); dated ones run newest first, matching the feed.
  const orderLedger = (groups: Group[]) => [...groups].sort((a, b) => {
    const first = groupTitle(a), second = groupTitle(b);
    const undatedFirst = first.startsWith("#"), undatedSecond = second.startsWith("#");
    if (undatedFirst !== undatedSecond) return undatedFirst ? -1 : 1;
    return second.localeCompare(first);
  });
  const stageGroups = { attention: orderLedger(attentionGroups), confirm: orderLedger(confirmBucket), approve: orderLedger(approveBucket) };
  const ledger = ledgerStage === "all" ? [...stageGroups.attention, ...stageGroups.confirm, ...stageGroups.approve] : stageGroups[ledgerStage];
  // The key handler is registered once, so it reads the live ledger and cursor through refs: a
  // closure captured between polls can step onto the wrong group or one that no longer exists.
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;
  const cursorRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const confirmIdsRef = useRef(confirmIds);
  confirmIdsRef.current = confirmIds;
  const approveIdsRef = useRef(approveIds);
  approveIdsRef.current = approveIds;
  function openGroup(group: Group, date = false) { setFocusDate(date); setEditingId(group.id); }
  function moveCursor(next: number | null) { cursorRef.current = next; setCursor(next); }
  useEffect(() => {
    if (cursor === null) return;
    document.querySelector(`[data-ledger-index="${Math.min(cursor, Math.max(0, ledgerRef.current.length - 1))}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (tab !== "review" || editingId || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      const groups = ledgerRef.current;
      const index = cursorRef.current === null ? -1 : Math.min(cursorRef.current, Math.max(0, groups.length - 1));
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        event.preventDefault();
        moveCursor(groups.length ? (index < 0 ? (key === "j" ? 0 : groups.length - 1)
          : Math.max(0, Math.min(index + (key === "j" ? 1 : -1), groups.length - 1))) : null);
        return;
      }
      if (index < 0 || groups.length === 0) return;
      const group = groups[index];
      if (key === "o") { event.preventDefault(); openGroup(group); return; }
      if (key === "x") { event.preventDefault(); openGroup(group, true); return; }
      if (key !== "enter") return;
      // Enter belongs to whichever real control the keyboard user tabbed into.
      if (target?.closest(".cell")) return;
      const fix = primaryFix(group, stateRef.current.jobs, confirmIdsRef.current, approveIdsRef.current);
      if (!fix) { setStatus(`${groupTitle(group)} needs judgment: press O to open it (${groupIssues(group)[0]?.label ?? "ready to approve"}).`); return; }
      event.preventDefault();
      void runFix(group, fix);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, editingId]);
  async function approveGroup(group: Group) {
    setQuickBusy(true);
    try {
      const reservation = await api<Reservation>(`/api/groups/${group.id}/prepare`, { version: group.version });
      await api(`/api/groups/${group.id}/approve`, { export_id: reservation.id, version: reservation.version });
      await refresh();
      setStatus("Approval queued. Originals remain until all approved artifacts are durable.");
    } catch (error) { setStatus(String(error)); } finally { setQuickBusy(false); }
  }
  // One-row scope of a batch verb: the ledger button and the toolbar button are the same call at
  // two widths, so a row can never claim something the batch path would refuse.
  async function runOnGroup(group: Group, action: () => Promise<string>) {
    setBusyGroups(previous => new Set(previous).add(group.id));
    try { setStatus(await action()); await refresh(); }
    catch (error) { setStatus(String(error)); }
    finally { setBusyGroups(previous => { const next = new Set(previous); next.delete(group.id); return next; }); }
  }
  const confirmGroup = (group: Group) => runOnGroup(group, async () => {
    const receiptIds = group.receipts.filter(receipt => receipt.timestamp_review === 1).map(receipt => receipt.id);
    const result = await api<{ confirmed: number; skipped: { reason: string }[] }>("/api/receipts/confirm-proposed",
      { groups: { [group.id]: group.version }, receipt_ids: receiptIds });
    return `Confirmed ${groupTitle(group)}: timestamp, physical bottom and legibility attested on ${result.confirmed} page${result.confirmed === 1 ? "" : "s"}.`;
  });
  const attestGroup = (group: Group) => runOnGroup(group, async () => {
    let version = group.version; let pages = 0;
    for (const receipt of group.receipts) if (!receipt.complete || !receipt.readable) {
      const result = await api<{ version: number }>(`/api/receipts/${receipt.id}/attest`, { version, complete: true, readable: true });
      version = result.version; pages++;
    }
    return `Attested bottom and legibility for ${pages} page${pages === 1 ? "" : "s"} in ${groupTitle(group)}; the stored timestamp was left alone.`;
  });
  const retryApproval = (group: Group) => runOnGroup(group, async () => {
    const job = failedApproveJob(group, state.jobs);
    if (!job) throw new Error("This group has no failed approval job to retry");
    await api(`/api/jobs/${job.id}/retry`);
    return `Requeued the approval job for ${groupTitle(group)}.`;
  });
  function runFix(group: Group, fix: NonNullable<Fix>) {
    if (fix.kind === "confirm") return confirmGroup(group);
    if (fix.kind === "attest") return attestGroup(group);
    if (fix.kind === "approve") return approveGroup(group);
    return retryApproval(group);
  }
  async function confirmReady() {
    const receiptIds = confirmGroups.flatMap(group => group.receipts.filter(receipt => receipt.timestamp_review === 1).map(receipt => receipt.id));
    const dates = confirmGroups.flatMap(group => group.receipts.map(receipt => receipt.date!)).sort();
    if (!window.confirm(`Confirm ${receiptIds.length} pages in ${confirmGroups.length} groups? This attests the physical bottom and readability for every listed page. Dates: ${dates[0]} to ${dates[dates.length - 1]}.`)) return;
    setQuickBusy(true);
    try {
      const result = await api<{ confirmed: number; skipped: { id: string; reason: string }[] }>("/api/receipts/confirm-proposed", {
        groups: Object.fromEntries(confirmGroups.map(group => [group.id, group.version])), receipt_ids: receiptIds });
      await refresh();
      const reasons = [...new Set(result.skipped.map(item => item.reason.replaceAll("_", " ")))];
      setStatus(result.skipped.length ? `Confirmed ${result.confirmed} pages; skipped ${result.skipped.length} (${reasons.join(", ")}).` : `Confirmed ${result.confirmed} pages from their stored OCR proposals.`);
    } catch (error) { setStatus(String(error)); } finally { setQuickBusy(false); }
  }
  async function approveAll() {
    setQuickBusy(true);
    let approved = 0; const failures: string[] = [];
    for (const group of approveGroups) {
      try {
        const reservation = await api<Reservation>(`/api/groups/${group.id}/prepare`, { version: group.version });
        await api(`/api/groups/${group.id}/approve`, { export_id: reservation.id, version: reservation.version });
        approved++;
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
    await refresh();
    setStatus(failures.length ? `Approved ${approved} groups; ${failures.length} failed (${failures[0]}).` : `Approval queued for ${approved} groups. Originals remain until all approved artifacts are durable.`);
    setQuickBusy(false);
  }
  return <main class="app">
    <header class="appbar"><div><p class="eyebrow">RECEIPT WORKSPACE</p><h1>Capture. Review. Keep.</h1></div>
      <p class="status" role="status" title={status}>{status}</p>
      <span class="badge">{attentionGroups.length ? `${attentionGroups.length} need attention` : `${reviewGroups.length} staging groups`}</span></header>
    <aside class="side"><section class="capture-panel"><div class="row">
      <button onClick={connect} disabled={connected || connecting}>{connecting ? "Connecting…" : "Connect Epson scanner"}</button>
      <button onClick={scan} disabled={!connected || scanning}>Start session</button>
      <button onClick={() => { controller?.abort(); setStatus("Stop requested; waiting for the current driver operation."); }} disabled={!scanning}>Stop</button>
      <button class="secondary" onClick={disconnect} disabled={!connected || scanning}>Disconnect</button>
      <label class="check"><input type="checkbox" checked={longPaper} disabled={scanning} onChange={event => setLongPaper(event.currentTarget.checked)} /> Long-paper profile</label>
    </div><div class="row"><label>OCR languages<select multiple disabled={scanning} onChange={event => {
      const values = Array.from(event.currentTarget.selectedOptions, option => option.value); setLanguages(values.length ? values : ["eng"]);
    }}>{["eng", "fra", "jpn", "chi_tra", "chi_sim"].map(language => <option value={language} selected={languages.includes(language)}>{language}</option>)}</select></label>
      <label>Scan year century<select aria-label="Scan year century" value={scanCentury} disabled={scanning} onChange={event => {
        const value = event.currentTarget.value; setScanCentury(value);
        try { localStorage.setItem("receipt-scan-century", value); }
        catch { setStatus("The scan century applies to this tab, but browser storage could not save it for the next visit."); }
      }}><option value="current">Current century ({Math.floor(new Date().getFullYear() / 100) * 100}–{Math.floor(new Date().getFullYear() / 100) * 100 + 99})</option>
        <option value="1900">1900–1999</option><option value="none">No assumption</option></select></label>
      <label>Expected receipt month<input type="month" aria-label="Expected receipt month" min="2000-01" max="2100-12" value={expectedMonth} disabled={scanning} onChange={event => {
        const value = event.currentTarget.value; setExpectedMonth(value);
        try { localStorage.setItem("receipt-expected-month", value); }
        catch { setStatus("The expected month applies to this tab, but browser storage could not save it for the next visit."); }
      }} /></label>
      <label class="file-import">Or import an unprocessed PNG (200 DPI)<input type="file" accept="image/png" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void importImage(file); event.currentTarget.value = ""; }} /></label>
      <div><strong>{pending} browser copies pending</strong><p><button class="secondary" onClick={resume}>Resume transfers</button></p></div></div>
      <p class="muted">The scan century applies to two-digit years on new scans and imports. This browser retains the choice. Printed four-digit years stay unchanged.</p>
      <p class="muted">The expected month defaults to last month and resolves numeric dates whose orders disagree: the interpretation inside that month wins. Clear it for no assumption.</p>
      <p class="muted">Transport completion does not confirm the physical bottom. Check it during review. OCR proposes supported timestamps; Save review confirms or corrects each proposal before approval.</p>
      {diagnostics.length > 0 && <details><summary>{diagnostics.length} incomplete/fault captures retained in this browser</summary>{diagnostics.map(item => <DiagnosticDownload item={item} key={item.id} />)}</details>}
    </section></aside>
    <section class="work">
      <nav class="tabs" aria-label="Workspace sections" role="tablist">
        <button role="tab" class="tab" id="tab-review" aria-controls="panel-review" aria-selected={tab === "review"} onClick={() => showTab("review")}>Review<span class="tab-count">{reviewGroups.length}</span>{attentionGroups.length > 0 && <span class="tab-count alert" title="Groups that need attention">{attentionGroups.length}</span>}</button>
        <button role="tab" class="tab" id="tab-exports" aria-controls="panel-exports" aria-selected={tab === "exports"} onClick={() => showTab("exports")}>Exports<span class="tab-count">{exportsReady.length}</span></button>
        <button role="tab" class="tab" id="tab-jobs" aria-controls="panel-jobs" aria-selected={tab === "jobs"} onClick={() => showTab("jobs")}>Jobs<span class="tab-count">{activeJobs.length}</span></button>
      </nav>
      <div class="panel" role="tabpanel" id="panel-review" aria-labelledby="tab-review" hidden={tab !== "review"}>
        <div class="toolbar"><div class="row"><button disabled={quickBusy || !confirmGroups.length} onClick={confirmReady}>Confirm ready pages ({confirmPages})</button>
          <button class="secondary" disabled={quickBusy || !approveGroups.length} onClick={approveAll}>Approve ready groups ({approveGroups.length})</button>
          {selected.size > 0 && <><button onClick={combine}>Make selected pages a manual group ({selected.size})</button>
            <button class="secondary" onClick={() => setSelected(new Set())}>Clear selection</button></>}</div></div>
        {reviewGroups.length > 0 && <div class="ledger-head"><span>Review · {reviewGroups.length}</span>
          <button class="filter" aria-pressed={ledgerStage === "attention"} onClick={() => setLedgerStage(ledgerStage === "attention" ? "all" : "attention")}>▲ fix {attentionGroups.length}</button>
          <button class="filter" aria-pressed={ledgerStage === "confirm"} onClick={() => setLedgerStage(ledgerStage === "confirm" ? "all" : "confirm")}>● one key {confirmBucket.length}</button>
          <button class="filter" aria-pressed={ledgerStage === "approve"} onClick={() => setLedgerStage(ledgerStage === "approve" ? "all" : "approve")}>✓ go {approveGroups.length}</button>
          <span class="legend">J K step · Enter fix · O open · X date fix</span></div>}
        {ledger.length > 0 && <div class="ledger">{ledger.map((group, index) => <LedgerCell key={group.id} group={group} index={index}
          fix={primaryFix(group, state.jobs, confirmIds, approveIds)} focused={cursor === index} busy={quickBusy || busyGroups.has(group.id)}
          edit={() => openGroup(group)} act={() => { const fix = primaryFix(group, state.jobs, confirmIds, approveIds); return fix ? runFix(group, fix) : Promise.resolve(); }} />)}</div>}
        {!reviewGroups.length && <section class="empty"><h2>Your staging area is ready</h2><p>Connect the scanner or import an unprocessed image to begin.</p></section>}
      </div>
      <div class="panel" role="tabpanel" id="panel-exports" aria-labelledby="tab-exports" hidden={tab !== "exports"}>
        <div class="row"><button disabled={connected || scanning || !state.drive.configured} onClick={async () => {
          try { const result = await api<{ url: string }>("/api/drive/connect"); location.assign(result.url); } catch (error) { setStatus(String(error)); }
        }}>{state.drive.connected ? "Reconnect Drive" : "Connect Google Drive"}</button>
          <span class="badge">{state.drive.connected ? "Drive connected" : "Drive not connected"}</span>
          {state.drive.connected && undelivered.length > 0 && <button disabled={Boolean(sendingExport)} onClick={async () => {
            setSendingExport("all");
            let queued = 0; const failures: string[] = [];
            for (const item of undelivered) {
              try { await api(`/api/exports/${item.id}/drive`); queued++; } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
            }
            await refresh(); setSendingExport("");
            setStatus(failures.length ? `Queued ${queued} approved PDFs for Drive; ${failures.length} failed (${failures[0]}).` : `Queued ${queued} approved PDFs for Drive delivery.`);
          }}>Send approved to Drive ({undelivered.length})</button>}</div>
        {!state.drive.configured && <p class="muted">Drive is optional until OAuth credentials and the existing receipts root are configured. Approved PDFs remain downloadable.</p>}
        {finalizingGroups.length > 0 && <div class="approving"><strong>Approving now ({finalizingGroups.length})</strong>
          {finalizingGroups.map(group => <p key={group.id}><code>{group.id.slice(0, 8)}</code> · {group.receipts.length} page{group.receipts.length === 1 ? "" : "s"} <span class="muted">waiting for the durable PDF; progress is tracked in Jobs</span></p>)}</div>}
        {approvedGroups.map(group => <div class="group" data-group-id={group.id} data-severity="clear" key={group.id}>
          <header><div><h2>{group.receipts[0]?.date || "Approved group"} <span class="muted">{group.receipts.length} page{group.receipts.length === 1 ? "" : "s"}</span></h2>
            <p><span class="badge">approved</span> · version {group.version} · {group.manual ? "manual grouping" : "same-minute grouping"}</p></div></header>
          <div class="chips">{group.receipts.map(receipt => <ReceiptChip key={receipt.id} receipt={receipt} selectable={false} />)}</div>
          {group.exports.filter(item => item.state === "ready").map(item => <div class="export-row" key={item.id}>
            <p><code>{item.path}</code></p><div class="row"><a class="button" href={`/api/exports/${item.id}/pdf`}>Download approved PDF</a>
              <button disabled={Boolean(sendingExport) || !state.drive.connected || Boolean(item.drive_id)} onClick={async () => {
                setSendingExport(item.id);
                try { await api(`/api/exports/${item.id}/drive`); await refresh(); setStatus("Selected approved PDF queued for Drive delivery."); }
                catch (error) { setStatus(String(error)); } finally { setSendingExport(""); }
              }}>{item.drive_id ? "Delivered to Drive" : "Send approved PDF to Drive"}</button></div></div>)}
        </div>)}
        {!exportsReady.length && !finalizingGroups.length && <section class="empty"><h2>No approved exports yet</h2><p>Approve a staging group to produce its PDF.</p></section>}
      </div>
      <div class="panel jobs" role="tabpanel" id="panel-jobs" aria-labelledby="tab-jobs" hidden={tab !== "jobs"}>
        <p class="muted">{activeJobs.length} pending/failed of {state.jobs.length} recorded jobs.</p>
        {state.jobs.map(job => <p key={job.id}><code>{job.kind} · {job.target.slice(0, 8)}</code> — {job.state}{job.error && `: ${job.error}`} {job.state === "failed" && <button onClick={async () => {
          try { await api(`/api/jobs/${job.id}/retry`); await refresh(); } catch (error) { setStatus(String(error)); }
        }}>Retry</button>}</p>)}
        {!state.jobs.length && <section class="empty"><h2>No background jobs recorded</h2><p>Processing and delivery jobs appear here.</p></section>}
      </div>
      {editingGroup && <GroupEditor key={editingGroup.id} group={editingGroup} selected={selected} focusDate={focusDate}
        select={(id, value) => setSelected(previous => { const next = new Set(previous); value ? next.add(id) : next.delete(id); return next; })}
        refresh={refresh} report={setStatus} close={() => { setEditingId(null); setFocusDate(false); }} />}
    </section>
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
