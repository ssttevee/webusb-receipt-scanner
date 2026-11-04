# Expanded receipt corpus review

Date: 2026-10-25

Related: [Initial review](receipt-sample-review-2026-10-11.md), [RA work items](receipt-automation-work-items.md)

## Conclusion

The corpus now contains **53 real captures**, including the complete replacement for the clipped return. All pass original-byte, row-layout and transport checks, and all have physical-bottom confirmations. Historical coverage now reaches every year from 2021 through 2026; all five required languages have labelled examples. This is enough to begin the capture-to-staging implementation and measured OCR comparisons.

Before scoring extraction accuracy, address two newly identified timestamp-label errors, confirm two label states and one numeric date convention, and resolve one severely faded date. Preserve the missing-time and invalid-printed-seconds cases as review tests. No automatic extraction accuracy or production-readiness claim follows from this visual audit.

## Method and evidence

- Compared against the original 27-sample audit: 26 retained originals have identical SHA-256 values; `280fda1a` is absent; `8d609737` replaces it. There are 26 additional receipts beyond that replacement.
- Rechecked all 53 bundles with `scripts/review-samples.py`, decoded lossless full-resolution PNGs, and independently rehashed every PNG's RGB pixels against the original checksum: **53/53 match**.
- Reviewed new receipt overviews, timestamp regions and long-receipt bottoms. Carried forward the prior visual assessments for byte-identical retained captures, with the four saved label corrections explicitly recorded.
- Private artifacts are under `.receipt-samples/review/update-02/`: `audit.json`, `visual-review.json`, full PNGs, strips, contact sheets, OCR and manual crops. The initial audit remains the historical baseline. Source ZIPs and labels were not changed by this review.
- Used local Tesseract 5.5.2, English only, PSM 11 on unenhanced full frames for navigation. All 53 OCR processes succeeded in approximately 37.8 seconds total on the workstation. This is neither a multilingual accuracy evaluation nor an amd64 NAS benchmark.
- Fixed the audit utility's TSV reader to treat quotes as literal text: a standalone OCR quote had swallowed subsequent TSV rows into one cue. A quote-followed-by-timestamp regression fixture passes; cue metadata was regenerated from existing TSVs without rerunning OCR.

## Inventory

| Check | Current result |
| --- | --- |
| Real raw captures | 53 |
| Matching original checksum and byte length | 53/53 |
| Valid row layout and reported height | 53/53 |
| Driver transport completion / physical-bottom label | 53/53 for each |
| Exact byte duplicates | 0 |
| Original RGB byte total | 769,626,144 bytes, approximately 734 MiB |
| Scanner settings | All 200 × 200 DPI, 8-bit RGB, 1,696 pixels wide |
| Nominal frame-height range | 111.12–880.75 mm |
| Label states | 51 confirmed, 2 unlabelled |
| Date/time fields | 53 dates, 52 times; one intentionally missing time |
| Time precision | 23 minute-only, 29 seconds-bearing, 1 missing |
| Related groups | 3 groups, 7 samples |
| Corpus splits | All 53 development; no held-out evaluation set |
| Header/layout coverage | Approximately 46 provisional families; not a distinct-merchant identity count |

Stored date labels have this year distribution: **2021: 2; 2022: 6; 2023: 7; 2024: 9; 2025: 1; 2026: 28**. Correcting `737f0eac` changes 2024 to 10 and 2026 to 27. These counts describe the saved labels, not independent confirmation of the severely faded date below.

### Language coverage

Counts overlap for mixed-language receipts and reflect stored labels before the recommended metadata correction.

| Label | Count | What it exercises |
| --- | --- | --- |
| English | 47 | Varied numeric/named-month dates, 12/24-hour clocks and multiple timestamp regions |
| French | 3 | Bilingual terminal fields including `HEURE/TIME`, numeric dates, French ticket/visit context |
| Japanese | 7 | Several layouts with actual `年/月/日` dates; `時/分` as well as colon-form times |
| Traditional Chinese | 3 | Mixed English/Chinese receipts; transaction dates remain numeric/ASCII |
| Simplified Chinese | 1 | Mixed-script receipt with numeric date and malformed printed seconds |
| Korean | 1 | Mixed English/Korean body/footer; ASCII timestamp; additional corpus coverage |

The required five languages now all appear, but label presence is not adequate language-specific release evidence. French date fields remain numeric or use an English month abbreviation; there is no demonstrated French month-name parser coverage. Chinese-language transaction-field notation remains a gap. Korean does not change the agreed five-language OCR scope. Incidental scripts also appear beyond the selected language labels.

## Earlier findings resolved

| Sample | Verified outcome |
| --- | --- |
| `8d609737` replacing `280fda1a` | Approximately **438.79 mm**, with complete footer, barcode and paper bottom. The earliest timestamp **14:56:36** is preserved, followed by later attempts. Group and page order are retained. |
| `9c8111b3` | Saved time is now **22:36:54**, resolving the PM conversion. |
| `7d7ec790` | Saved time is now **09:51:07**, resolving the seconds discrepancy. |
| `5bb738f1`, `8d279b33` | Both are now marked confirmed. |
| `f3776b66` | Time remains null, correctly preserving missing source evidence. |

The removed clipped sample is no longer part of the current corpus. Its old private decoded image and review remain useful incomplete-image evidence, but are not a retained raw-bundle negative in this snapshot.

## New actionable findings

Follow-up: the user confirmed these samples were corrected. Saved manifests now contain `0324142b` **09:46**, `737f0eac` **2024-06-02 12:14**, confirmed states for `3c8472ec`/`804aa971`, and `eng` for `b337f00c`. The supplied `f1ec813c` date remains **2022-11-11** with user confirmation; this is user-attested ground truth rather than recovered faded pixels. All 53 states are now confirmed. The table below preserves the findings at review time; the corrected snapshot has 48 English labels, 10 dates in 2024 and 27 in 2026.

| Sample | Finding | Recommended action |
| --- | --- | --- |
| `0324142b` | Header/opening timestamp is **2022-06-17 09:46 AM**; `Check Closed` is **09:47 AM**. Current label selects the later time. | Use **09:46** under the earliest-supported-transaction policy; retain closing time as secondary evidence. |
| `737f0eac` | Footer shows **JUN 2 2024 12:14**. Scheduled `Start of visit` is **12:30** on the same date. Saved label is **2026-06-02 12:30**. | Correct to **2024-06-02 12:14**. Preserve the scheduled visit as nontransaction context. |
| `3c8472ec` | Time **12:21:41 p.m.** agrees, but state is unlabelled. Printed **01/09/2022** is ambiguous; the supplied September 1 label assumes day/month order. | Confirm the intended calendar date using archive/personal context, then mark confirmed. Do not silently reinterpret it as January 9. |
| `804aa971` | Date/time agrees with payment-reference **2022-07-03 11:56:59** and corroborating register **7/3/2022 11:57 AM**, but state is unlabelled. | Mark confirmed after checking. Preserve the explicit register time and reference context as evidence; avoid treating arbitrary ID digits as independent timestamps. |
| `b337f00c` | Date/time agrees; the English receipt has an empty language list. | Add `eng`. This would raise the English-labelled count to 48. |
| `f1ec813c` | **12:54:55 PM** is readable, but the date is severely faded and crossed by pen marks. This review cannot independently verify the entire saved **2022-11-11** date. | Check the paper/archive or retain an explicit unresolved-date annotation; exclude from strict date-accuracy scoring until resolved. A new scan may not restore physically faded ink. |

### Invalid printed seconds: keep as a review case

`5db6ae55` literally prints **2021-12-21 11:53:60**. Its existing **11:53** label preserves the readable hour/minute at minute precision. The `:60` is malformed civil-time evidence, not permission to carry to **11:54**, invent **:00**, or silently accept a seconds-bearing timestamp. Keep the literal source and malformed-seconds note, and route extraction to review. This needs an explicit evaluation category rather than an ordinary clean-timestamp success.

The remaining new timestamp labels agree at their declared precision, allowing for explicitly recorded locale context. For example, `1fffdfb2` has ambiguous **06/01/24** with a user-supplied June 1 interpretation. The raw source alone does not uniquely determine month/day order. Minute-only sources corroborating seconds-bearing sources do not independently establish the seconds.

## New processing evidence

- **Complete long frames:** new examples include `49ea4923` at **643.51 mm**, `804aa971` at **630.81 mm**, and replacement `8d609737` at **438.79 mm**. Together with prior **450.47 mm** and **880.75 mm** captures, there are five complete frames above 400 mm. Physical scans above 508 mm support the patched driver's long-paper behavior; the approximately 1,000 mm / supported-resolution matrix remains open.
- **Faded archive:** the long Japanese sample, several 2024 English examples, and the marked-up restaurant slip provide genuinely difficult originals. Preserve grayscale/color; thresholding cannot be assumed to recover lost strokes.
- **Time notation:** Japanese `09時12分` and contiguous `2023年04月02日12時48分` exercise parsing beyond ASCII colons. Terminal **14:35 57** exercises space-separated seconds.
- **Distractors:** Japanese store hours, next-day opening notation, coupon date ranges, product years and scheduled visit times reinforce the need for transaction context before selecting the earliest candidate. `JAN` barcode suffixes are not month evidence.
- **Full-context references:** the long reference-based timestamp has corroborating register evidence. This does not justify generic timestamp extraction from every order/reference ID.

No OpenCV procedure was generated or promoted during this review.

## Next steps

1. Save the two timestamp corrections and metadata confirmations above; retain explicit unresolved/invalid-source annotations for scoring.
2. Begin the durable capture-to-staging vertical slice and a repeatable date/time benchmark. Measure missing-field handling, review routing and each language separately.
3. Freeze a regression split by merchant/layout and related group before tuning. Every current image has now been exposed to review/exploratory OCR, so obtain genuinely unseen receipts later for release evaluation.
4. Add targeted gaps incrementally: French month-name dates, Chinese transaction-field notation, unrelated same-minute vendors, genuine blank/unreadable negatives, midnight/year-boundary cases, a 30–40 receipt session, and approximately 1,000 mm physical length verification. Broader collection is not a prerequisite to implementation.
