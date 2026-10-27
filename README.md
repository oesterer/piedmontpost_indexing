# Piedmont Post indexing

This repository contains offline newspaper indexing and automation. The public search website lives separately in **[piedmontpost](https://github.com/oesterer/piedmontpost)** and is served at **https://oesterer.github.io/piedmontpost/**.

## Local setup

Keep the repositories side by side:

```text
code/
  piedmontpost/           # public HTML/JS/CSS, manifest.json, indexes/
  piedmontpost_indexing/  # scripts/, tests/, cache/, settings.json
```

Indexing requires macOS with Swift/PDFKit (Xcode Command Line Tools), Node.js 22+, and a browser. Install dependencies once:

```sh
cd ../piedmontpost_indexing
npm ci
```

Index new online issues using installed Chrome:

```sh
npm run index:archive -- --browser-channel chrome
npm run verify:indexes
npm run publish:site
```

Enter the archive password at the hidden prompt, or provide `PIEDMONT_ARCHIVE_PASSWORD` through a secret/environment variable. No password is stored in Git. Alternatively install Playwright Chromium with `npx playwright install chromium` and omit `--browser-channel chrome`.

The indexer generates data in ignored `output/`. `publish:site` copies only validated generated index files and the manifest into the sibling website checkout; it never modifies frontend code or commits/pushes automatically when run locally. Review and commit the cache here and the generated data in the website repository separately.

To use a different website checkout, set `SEARCH_SITE_DIR` to its absolute path. Set `SEARCH_OUTPUT_DIR` to override `output/`. Tests also use `SEARCH_SITE_DIR` to load the real website JS and worker, avoiding duplicate frontend templates in this repository.

## Cache and incremental behavior

Keep `cache/manifest.json` and `cache/issues/*.json` in Git. They hold successfully extracted page text and detected article titles. A normal run skips PDFs already cached by source URL path. Downloads use a 10-second timeout with two retries; failures are retried on a later run. If a rebuild fails for an already-cached issue, the old text remains available and `refreshFailure` is recorded in its manifest entry. A subsequent normal run retries that issue instead of skipping its older cache; successful extraction clears the flag. Program/parade links are ignored.

A successfully indexed current dated link supersedes an unlisted cached URL for the same date. An old cache JSON may remain for recovery but is excluded from publication. Missing dates and failed replacements remain intact. Two PDFs explicitly listed for the same date remain separate.

Compiled Swift binaries, compiler caches, discovery snapshots, lock files, `node_modules/`, and `output/` stay ignored. No PDF copies or page images are published.

To re-extract all discovered issues, including headline detection changes:

```sh
npm run index:archive -- --browser-channel chrome --rebuild
```

To regroup existing text without downloading/extracting PDFs:

```sh
npm run publish:indexes
npm run verify:indexes
npm run publish:site
```

## Automatic quarter grouping

`settings.json` contains only search batch size and memory-cache size:

```json
{
  "batchSize": 20,
  "memoryCacheBytes": 16777216
}
```

There is no manually maintained quarter cutoff. Each publication computes the end of the most recently completed calendar quarter using the newspaper's **America/Los_Angeles** timezone. All dates through that cutoff use quarterly indexes; newer issues use individual weekly indexes.

For example, during October–December 2026, the cutoff is September 30, 2026. Starting January 1, 2027, it becomes December 31, 2026. The next publication automatically consolidates Q4, even if no new PDF was added. The computed date is recorded as `quarterThrough` in `manifest.json` as output metadata, not configuration.

Published indexes use content-hashed immutable filenames. Old generations in the public repository are retained so visitors with an older manifest can finish searching. The manifest is copied last. Unchanged polling preserves its timestamp to avoid unnecessary commits/deployments. On a fresh runner, publication compares against the website checkout's manifest.

## Article titles and non-article text

Detected headlines are approximate. Recurring delivery/subscription boxes, publishing instructions, and staff-role listings are treated as non-article layout boundaries. Their full page text remains searchable, but it is not attached to a nearby article title. The search UI already falls back to a neutral page link when a match has no detected article heading. Existing cached issues need re-extraction to receive extractor changes; republishing alone does not recalculate headlines.

## Validation

```sh
npm test
npm run verify:indexes
```

Tests exercise incremental behavior, retries, replacement PDFs, headline/subtitle handling, automatic quarter boundaries, JSON publishing, browser search sessions, worker/UI behavior, and copying generated data without overwriting frontend code. Tests require the website checkout; index verification requires generated `output/` (run `publish:indexes` first on a fresh checkout).

`verify:indexes` checks every generated page, title, and PDF URL against the persistent cache. Search itself remains entirely client-side; GitHub-hosted indexing is maintenance only.

For staff-friendly scheduled and manual operation, see **[AUTOMATION.md](AUTOMATION.md)**.

Only JSON index files are generated and published. Legacy `.json.gz` and `.json.br` files are removed automatically from generated output and the public checkout.
