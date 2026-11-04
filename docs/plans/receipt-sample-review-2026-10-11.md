# Initial real receipt corpus review

Date: 2026-10-11
Related: [Architecture](receipt-automation-architecture.md), [RA work items](receipt-automation-work-items.md)
Corpus: 27 workstation sample ZIPs in `.receipt-samples/`.

## Conclusion

This is a useful starting corpus for the first capture-to-staging pipeline and image/OCR comparisons. There is substantial merchant/layout and print-condition variation despite consistent scanner settings. Correct a few label/capture issues before using it to score accuracy. Broader language and historical coverage can be added incrementally; collecting a much larger corpus is not a prerequisite to starting implementation.

## Method and private artifacts

- Inspected metadata and original bytes for every bundle; verified SHA-256, lengths, complete rows, and reported dimensions.
- Decoded raw 8-bit RGB originals losslessly into private PNGs. Reviewed all receipt overviews and full-resolution date/time and bottom regions, including the long captures.
- Used a local Tesseract 5.5.2 English-only, PSM 11 pass on unenhanced full frames to help locate text regions. This is exploratory navigation, not a validated date/time extractor, multilingual OCR comparison, or NAS performance benchmark.
- Added a read-only audit utility at `scripts/review-samples.py` (Pillow/NumPy required). Raw ZIPs and labels were not edited.
- Detailed audit, OCR text/coordinates, decoded originals, strips, contact sheets, and per-sample visual notes are under `.receipt-samples/review/`, excluded from Git. Keep private receipt content there rather than in this aggregate planning report.

## Inventory

| Check | Result |
| --- | --- |
| Real raw captures | 27 |
| Nonempty originals, matching checksum and byte length | 27/27 |
| Row layout and reported-height consistency | 27/27 |
| Driver-reported transport completion / successful EOF | 27/27 |
| Explicit physical-bottom confirmations | 26/27 |
| Exact byte-identical duplicates | 0 |
| Original RGB byte total | 408,856,416 bytes (approximately 390 MiB) |
| Scanner resolution/format | All 200 × 200 DPI, 8-bit interleaved RGB |
| Scan width | All 1,696 pixels, approximately 215.4 mm |
| Label states | 25 confirmed; 2 unlabelled with date/time already entered |
| Date/time labels | Date present on all 27; time present on 26 |
| Label time precision | 9 minute-only, 17 seconds-bearing, 1 missing |
| Corpus splits | All 27 marked development; no reserved evaluation split |
| Visible merchant/header families | Approximately 21; not a merchant-identity classification benchmark |
| Labelled related groups | 3 groups spanning 7 samples |
| Labelled transaction years | All 2026; no 2021–2025 coverage yet |

Transport completion is not physical completeness: one returned frame visibly ends before the receipt does.

### Languages

Labels include English on 26 samples, traditional Chinese on 2 (overlapping English), and Japanese on 1. No French or simplified Chinese labels are present.

The Japanese sample exercises Japanese year/month/day notation. The two Chinese-labelled samples contain Chinese item text, but their date/time fields are English/ASCII. There is additional incidental Japanese/Han item text and traditional-Chinese promotional text in English-labelled receipts. These are useful mixed-script examples, but they do not establish Chinese date-field coverage. Token French phrases such as a bilingual thank-you do not constitute French date-format coverage.

## Actionable findings

| Sample prefix | Finding | Recommended action |
| --- | --- | --- |
| `280fda1a` | The long return image stops through footer text at the normal approximately 355 mm frame boundary. Its bottom is not confirmed. Visible timestamp evidence is readable, but the full receipt is not preserved. | Rescan using the long-paper profile. Retain this original as an incomplete-scan negative rather than counting it as a complete approved-artifact sample. |
| `9c8111b3` | The printed clock has a PM suffix, but the expected value remains in the morning half of the day. | Correct the 24-hour time to **22:36:54** after checking the original. The related `4beb5f90` is already labelled **22:36:57**, yielding a same-minute pair. |
| `7d7ec790` | The seconds-bearing source reads **09:51:07**; the label says **09:51:01**. A second source gives minute precision only. | Confirm the seconds against the strip, then use **09:51:07**, or intentionally label **09:51** if only minute-level ground truth is desired. Do not retain unsupported seconds. Filename minute is unaffected. |
| `5bb738f1`, `8d279b33` | Entered values agree with the visible evidence, but state remains `unlabelled`. | Mark confirmed after reviewing, then Save to workstation folder. |
| `f3776b66` | There is no visible transaction time. | Keep a missing/null time as source ground truth. This is a valuable manual-staging test; do not fabricate a source timestamp. |

The rest of the supplied date/time labels agree with the visually readable evidence at their declared precision. This is a visual label audit, not an automatic extraction accuracy result. Corrections above are recommendations; the original manifests remain unchanged.

## Particularly useful cases

- **Earliest timestamp in different regions:** `4aba41ae` has an earlier terminal time below a later header time. `4d850a27`, `8363b85f`, `e068dbfc`, and `35a9efae` have close but distinct register/terminal timestamps. They are good checks against selecting only the first/last OCR match.
- **12/24-hour conventions:** dotted `a.m.`/`p.m.`, uppercase AM/PM, leading-zero differences, named months, unpadded numeric dates, YMD and two-digit-year forms are represented. `35a9efae` even combines a 24-hour clock with a PM suffix.
- **Timestamp distractors:** `7d7ec790` contains promotion dates; `5bb738f1` has a timestamp-like order ID. Source context must distinguish transaction fields from promotions and embedded identifiers.
- **Faint and difficult printing:** `6b7587e4`, `965b3d48`, `fc9c78c0`, both narrow bakery copies, and the marked-up colored-stock `8d279b33` are valuable. Weak/damaged strokes are already visible in the originals; aggressive thresholding could remove remaining evidence.
- **Stamp overlap:** `a73697fc` has a stamp across the lower transaction region while a timestamp also appears near the header. Retaining color/grayscale is important for comparison.
- **Long receipts:** complete captures include `4b35b4e0` at approximately **450.5 mm** and `a73697fc` at approximately **880.7 mm**. The clipped return is a third long-labelled case, not proof of a third complete long capture.
- **Missing time and clock discrepancies:** the three-page labelled group containing `f3776b66`, `a3a85fbb`, and `68dd3203` includes a date-only page and clocks about an hour apart. Same-minute grouping cannot reconstruct that group automatically; manual combine and earliest-member naming cover it.
- **Original/return grouping:** `35a9efae` and `280fda1a` have different transaction minutes; manual combine remains appropriate under the confirmed grouping policy.
- **Template similarity across vendors:** several terminal slips share nearly identical processor layouts. Those layouts can help locate timestamps, but cannot alone establish vendor identity for a grouping veto.

## Processing implications

1. **Detect paper geometry before ranking images or OCR.** All scans include a large textured dark feeder background on the right. Most normal captures also contain a white tail added by the original backend. Neither region should dominate image-quality metrics or OCR work.
2. **Use full-resolution regions/tiles for extraction.** Downsampled tall previews hide digits that are clear in the original. Do not use a browser preview as the OCR master.
3. **Preserve faint strokes and make grayscale/color a valid result.** This set has enough faint cases to test whether thresholding loses date/time characters. A clean-looking binary result is not proof of readability.
4. **Discover all transaction timestamp candidates.** The earliest may be in the header, terminal section, or opening-time footer. Pair date and time by source context; do not infer timestamps from arbitrary IDs.
5. **Record precision.** Minute-only and seconds-bearing timestamps can be consistent within the same naming minute. Missing seconds are not observed `00`; avoid manufacturing precision or treating that as a contradictory timestamp.
6. **Keep acquisition, physical completeness, extraction clarity, and approval separate.** The clipped return passes byte/EOF checks but must not be marked complete for artifact approval.

No OpenCV recipe was generated or promoted during this review.

All 27 private full-resolution PNGs were decoded back and their RGB pixels rehashed against the original manifest checksum; every one matches. The exploratory English OCR completed on all 27 with no process errors, in approximately 21.9 seconds total on the workstation. A successful OCR process is not correct extraction: it missed or fragmented several visually readable timestamps. This timing excludes the rest of the production pipeline and is not an x86 NAS benchmark.

## Next steps

1. Address the clipped capture, PM conversion, seconds discrepancy, and two label-state flags. Keep the missing-time example.
2. Start implementing and benchmarking the vertical slice with this corpus. Report complete, incomplete, missing-time, and language-specific cases separately.
3. Establish a small regression holdout by whole layout/related group before tuning procedures. These 27 have now been inspected and used for exploratory OCR; a later genuinely unseen set should provide stronger release evidence.
4. Add targeted samples when convenient: actual French date fields, simplified-Chinese date fields, several Japanese/traditional-Chinese merchant layouts with non-English date notation, old receipts from 2021–2025, an approximately 1,000 mm receipt with its bottom clearly present, and unrelated same-minute vendors.
5. Add genuine blank/blurred or otherwise unreadable captures for rejection tests rather than assuming readable receipts cover that behavior. Synthetic fixtures can cover midnight/month/year boundaries and missing-field plumbing.

Keep matched groups and repeated templates together when splitting data. Do not tune a date-region rule on one member and claim the same-template counterpart is unseen evaluation data.
