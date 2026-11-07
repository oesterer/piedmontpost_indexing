# Alternative Python PDF parser

`scripts/index-pdfs.py` is an **opt-in alternative** to `scripts/index-pdfs.swift`. It uses pdfplumber for PDF text, character coordinates and font sizes, and ports the existing layout heuristics into Python. It does not use Swift, PDFKit or AppKit. It is intended for Linux/container execution as well as local comparison on macOS.

**Swift remains the default.** The existing Swift source and automated workflow's runner/parser choice are unchanged. Neither cache contents nor public indexes are rewritten merely by adding this alternative.

## Install the optional dependency

Use Python 3.11 or newer (the Python layout code itself uses syntax compatible with 3.9+):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-python.txt
```

If macOS's `python3` is an older system Python, select your newer interpreter explicitly, e.g. `/opt/homebrew/bin/python3 -m venv .venv`. The virtual environment is ignored by Git. For Windows, use `.venv\Scripts\python.exe` instead of `.venv/bin/python` for the standalone parser; the complete local Git updater is currently intended for macOS/Linux.

The direct parser dependency is pinned in `requirements-python.txt`. Its dependencies are resolved by pip; this file is not a complete transitive lockfile.

## First comparison: one local PDF, no cache changes

```sh
.venv/bin/python scripts/index-pdfs.py --extract-one \
  "10-21-26 Post v2 - Web.pdf" \
  /tmp/oct21-python.json \
  "https://example.org/original-issue.pdf" \
  2026-10-21
```

The example URL is a placeholder for test output; provide the actual PDF URL before using extracted data in production. The CLI accepts the same `--extract-one INPUT OUTPUT SOURCE_URL DATE_OR_DASH` contract as Swift. Use `-` for cover-date inference. The output parent directory must exist.

For comparison, the existing compiled Swift executable can produce another temporary file:

```sh
cache/pdf-indexer --extract-one \
  "10-21-26 Post v2 - Web.pdf" \
  /tmp/oct21-swift.json \
  "https://example.org/original-issue.pdf" \
  2026-10-21
```

That comparison command assumes the Swift executable has already been compiled. The Python command does not compile or call it.

Check page 2's full text and article list in particular: `Misha Edel` should remain searchable without receiving the missed-delivery heading. Also check genuine neighboring story titles, and compare additional layouts before replacing the default parser. Raw text order, font metrics and detected regions need not be identical across PDF engines.

## Use from the indexer

```sh
npm run index:archive -- --browser-channel chrome --parser python
```

Interpreter selection is:

1. `--python PATH`, when supplied.
2. `PDF_PYTHON` environment variable.
3. This repository's `.venv/bin/python` (or Windows equivalent), if it exists.
4. `python3` (`python` on Windows).

The Node wrapper checks that `pdfplumber` is importable before processing PDFs. If the environment exists but the dependency was not installed successfully, it reports an actionable error instead of falling back to Swift.

**Cache identity does not include parser choice.** Existing successful issues are still skipped unless `--rebuild` is specified. To compare a full extraction without altering the existing cache or publication, use separate directories:

```sh
npm run index:archive -- --browser-channel chrome --parser python \
  --cache-dir cache-python --output-dir output-python
```

`cache-python/` and `output-python/` are ignored experimental directories. Keep them separate until the results have been reviewed. The normal `verify:indexes` command uses the repository's primary `cache/` and default output; it does not automatically switch to this experimental cache. Do not run `publish:site` on experimental output without deliberately selecting and validating it.

To re-extract the existing primary archive intentionally:

```sh
npm run index:archive -- --browser-channel chrome --parser python --rebuild
npm run verify:indexes
```

This changes primary cached extraction data and can create new public index hashes after publication, even though the JSON schema remains compatible. It is a comparison/migration step, not required merely to try the standalone parser.

## Local one-command updater

After choosing Python for production and installing the dependency:

```sh
npm run update:local -- --parser python
```

It accepts `--python PATH` too. The local updater's macOS-only guard now applies only to the Swift backend. Python mode also sets `PDF_PARSER_TEST_BACKEND=python`, so the Mac-only Swift regression test is skipped rather than introducing a hidden compiler dependency. The Python layout and optional PDF integration tests still run. Default Swift mode continues to run its existing test.

The indexing workflow has **not** been moved to Linux. A later migration would install Python and `requirements-python.txt`, pass `--parser python`, and select an appropriate Linux runner/container. Playwright, Node, Git-backed cache, JSON publishing and browser search are already independent of Swift.

## Extraction stages

1. pdfplumber opens the PDF and supplies a usable page list.
2. Use an explicit issue date or infer an English month-name date from the cover. Unlike the direct Swift CLI's shape-only date check, explicit Python hints must be valid calendar dates.
3. Deduplicate overprinted characters; extract content-flow words with font sizes and constituent characters.
4. Group adjacent words into line segments. Different baselines or large horizontal gaps start a new segment, preventing adjacent newspaper columns from becoming one line.
5. Convert pdfplumber's top/bottom coordinates into normalized, bottom-left-origin `Box` values, matching the geometry used by the Swift heuristics.
6. Assemble cleaned full-page text from the extracted line order.
7. Apply the ported body-font estimate, headline filters, multiline heading grouping, subtitle attachment, column inference and nearest-heading body assignment.
8. Keep recognized service/staff blocks as non-article boundaries. Emit only qualifying article regions, while preserving full-page text.
9. Write the issue/page JSON atomically. No PDF rasterization, page images, cross-page article joining or OCR is added.

The headline thresholds match the Swift version: minimum ordinary heading size `max(15, bodySize × 1.65)`, subtitle size at most 85% of its parent, the same column/position checks and 100-character minimum article text. See [PDF-PARSING.md](PDF-PARSING.md) for the detailed original algorithm.

Line formation necessarily differs: PDFKit supplies line selections, while this alternative constructs lines from pdfplumber words. Text ordering, ligature handling, glyph boxes and missing font mappings can change results. Python's Unicode cleanup also repairs unsupported surrogate characters differently. Identical schema does not imply identical extraction bytes or article boundaries.

## Tests and current validation limits

```sh
npm run test:python
```

This runs Python standard-library tests for layout, subtitle/staff regressions, cleanup, dates, coordinate conversion, issue schema and atomic output, plus Node adapter tests. It never invokes Swift.

When pdfplumber is installed, the same suite also extracts a small generated text PDF, rejects a generated blank PDF with the expected OCR message, and tests the October 21 newspaper PDF if that optional local file is present. If dependencies or the sample are absent, those integration cases are explicitly skipped. Pure layout tests do not require pdfplumber.

During implementation, package download/DNS access was unavailable in the execution environment. The pure layout tests and Node integration tests ran; the real PDF library/sample tests could not run here. Installing the dependency and running `npm run test:python` is required before treating this as a validated production replacement. No real archive cache was changed to Python-generated data during implementation.

## Swift dependency audit

| Component | Current status |
|---|---|
| `scripts/index-pdfs.swift` | Only production Swift source. Retained unchanged and still the default PDF extractor. |
| Swift branch of `makeExtractor` in `scripts/index-archive.mjs` | Compiles and invokes the existing extractor only when Swift is selected. |
| `cache/pdf-indexer`, `cache/swift-cache/` | Generated executable/compiler artifacts for that one extractor, not separate applications. |
| `tests/headlines.test.mjs` | Swift-specific layout regression test; skipped outside macOS and in the local updater's Python mode. |
| `scripts/update-local.mjs` | Platform guard is conditional on parser choice; the rest is Node and Git. |
| Scheduled workflow | Still requests macOS for the default Swift backend; no other Swift processing stage exists. |
| Index grouping, verification, publishing and browser search | Node/JavaScript; no Swift dependency. |

Library documentation: [pdfplumber](https://github.com/jsvine/pdfplumber). Data contract: [DATA-FILES.md](DATA-FILES.md).
