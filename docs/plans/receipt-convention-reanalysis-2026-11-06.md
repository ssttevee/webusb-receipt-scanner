# Explicit date conventions and durable reanalysis

Date: 2026-11-06

Related: [Selective fallback](receipt-selective-fallback-2026-11-06.md), [runtime contract](../application-runtime.md), RA-12 / RA-14 / RA-15.

## Implemented workflow

Staged receipts now have receipt-local date-convention controls, cached reparse, fresh OCR and analysis history. The operator explicitly chooses numeric order and a two-digit-year century, or leaves either unresolved. The application records requested and effective values, their scope, and their source.

**Apply convention to saved OCR** reparses retained text/boxes without another engine call. **Run OCR again** uses the same reference master and the configured primary/fallback engines under the requested convention. These actions create new durable analysis runs. Old evidence remains available through **Analysis history**.

The application does not infer a date convention from expected labels or silently apply a receipt choice to another receipt. An explicit application-default option snapshots the current environment setting. **No assumption** explicitly leaves the field unresolved even when an application default exists.

Supported fields remain unconfirmed OCR proposals until Save review. Existing manual corrections retain priority over new proposals. **Use proposed timestamp** copies a proposal into the local form; Save review persists it. Local unsaved field edits disable path preparation and approval, including an already prepared approval.

## Measurement

The nine policy-related cases received explicit experiment inputs: numeric orders from the printed format/prior date confirmation, and a declared 2000-century assumption where needed. The private policy map records each input's basis. These are human policy inputs, not autonomous extraction successes.

| Scenario | Matching proposals | Review | Fresh OCR |
| --- | --- | --- | --- |
| Prior live fallback baseline, parser v2 | 31/53 | 22 | Yes; historical run |
| Saved evidence replay, stricter parser v3, no conventions | 30/53 | 23 | No |
| Same saved evidence with nine declared conventions | 33/53 | 20 | No |
| Fresh policy-aware pipeline with those nine conventions | **40/53** | **13** | **Yes** |

Cached convention changes directly resolved three cases. Six still lacked sufficiently reliable recognition, association or clock evidence. Fresh policy-aware OCR made those cases eligible for independent fallback and resolved all nine declared-convention receipts. The fresh run had no wrong date/minute or asserted seconds on this inspected development set; all 23 proposals with seconds-bearing labels matched those seconds. Both expected source-review cases stayed unresolved.

The fresh run used the same frozen 53 sources/labels and pinned Tesseract/RapidOCR versions in an amd64 container under emulation, with a two-CPU quota and 8 GiB limit. OCR/handoff work totalled about 367.7 seconds; decode, artifact and diagnostic-matrix work totalled about 373.3 seconds. These are not NAS latency measurements or unseen accuracy estimates.

### Clock ambiguity found after date resolution

One retained reading says `6:22:25 PH` where the visible source uses PM. Once a century is supplied, the old parser could interpret that clock as 06:22:25. Parser v3 flags an unrecognized two-letter A/P suffix after a 12-hour-sized clock instead of assigning a time.

The same check conservatively withdraws one previously correct noon reading, `12:45:42 PH`, from cached-only proposals. Fresh independent fallback reads its PM suffix and restores the supported value. That recovery is separate from the nine date-policy inputs; it is not credited as a convention-only improvement. The application never turns `PH` into `PM` by substitution.

The parser also accepts an unambiguous four-digit-year position when another source on the receipt uses a configured two-digit YMD form. A YMD setting does not invalidate an otherwise clear `05/29/2024` source. Remaining month/day ambiguity still requires evidence or an explicit convention.

### Policy sensitivity

A diagnostic matrix evaluated twelve order/century combinations on each of the nine saved-OCR cases. Ten of the 108 trials produced incorrect proposals under intentionally unsuitable conventions. The benchmark reports those trials; it does not select the best policy from their scores. This demonstrates why receipt conventions remain explicit and timestamp confirmation remains mandatory.

## Version and recovery rules

- Each run has its own ID, monotonically increasing receipt analysis version, immutable policy snapshot, mode and state.
- Policy requests use the current group version. They invalidate reserved exports and require preparation against the new version.
- A newer request supersedes an older pending/running analysis. A stale run may retain historical evidence but cannot update current fields.
- Commit checks the active receipt run/version, staging state and job lease owner. Lease replacement prevents an old worker from publishing a result or failure.
- Each attempt writes to its own directory. Final evidence has a checksum sidecar before database commit. A replacement worker can reuse a complete matching artifact without another engine call.
- Manual fields saved during analysis remain intact. New machine proposals appear beside them as evidence.
- Active analysis blocks approval. After a failed reanalysis, the old master/evidence remain available and an explicit manual resolution can still proceed.
- Deletion blocks active writers, removes pending run jobs/history with the staged receipt, and retains the capture tombstone.

The database migrates from schema 1/2 to **schema 3**. New columns identify the active analysis and its version; `analysis_runs` stores run policy/state and evidence references. Complete manual confirmations remain intact. A legacy ready receipt gets a durable pre-change snapshot on its first explicit reanalysis. Approved exports remain read-only and keep their immutable snapshots.

## Repeat the experiment

Cached policy evaluation needs no model dependencies beyond the normal Python requirements:

```sh
python -m server.policy_benchmark \
  --samples .receipt-samples \
  --source .receipt-samples/ocr-hybrid-2026-11-03/hybrid \
  --policies .receipt-samples/policy-assistance-2026-11-06/policies.json \
  --output .receipt-samples/policy-evaluation-local \
  --review-cases .receipt-samples/review/extraction-review-cases.json
```

The private input files are local corpus artifacts. Supply an explicit prefix-to-policy map with a basis for each choice; expected dates/times are separate scoring data. `--fresh` uses persistent Tesseract and bounded RapidOCR on every original under those policies. Run that mode in the enhanced image, with a new private output directory, networking disabled, two CPU quota and 8 GiB limit. The script validates the frozen cohort and rejects unrecognized receipt inputs.

Each result states whether OCR was fresh. Cached reparses record their source OCR timing separately from new parse timing. The saved branches remain independent: one partial read from each engine cannot become two-pass corroboration.

## Verification and remaining work

The regression suite covers stale requests/runs, lease replacement, durable artifact recovery, manual edits during analysis, failure/manual resolution, immutable history, history checksum failure, deletion, and schema migrations. Browser coverage checks receipt-local policy application, prior-analysis inspection and the unsaved-field approval guard. Live container checks cover saved reparse, fresh recognition under a convention, AM/PM fallback recovery, approval and exact source-pixel PDFs.

Current checks pass: **89 Python tests**, **5 application browser tests**, TypeScript/Vite, lint and the real-sample container scenarios. The built images retain the same HTTP port, volume interfaces and non-root identity.

This remains a policy-assisted development scenario. A fully automatic intake convention or trusted layout rule needs separate confirmation and evaluation. Genuinely unseen receipt layouts and actual NAS performance remain release inputs. The thirteen unresolved fresh-scenario receipts include the expected source defects and remaining difficult recognition/association cases.
