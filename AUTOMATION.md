# Weekly indexing across two Git repositories

The **private indexing repository** owns PDF processing, the Git-backed cache, and the scheduled/manual `Update newspaper search` workflow. The **public website repository** owns the search UI, generated indexes at its root, and the separate `Deploy search website` Pages workflow.

## One-time migration and configuration

1. Commit the indexing repository files, including `cache/manifest.json`, `cache/issues/*.json`, and `.github/workflows/update-search.yml`, to the default branch of `oesterer/piedmontpost_indexing`. Use a private repository if the maintenance data should be private. Generated `output/` and installed dependencies are ignored.
2. Commit the root-level website files and `.github/workflows/deploy-pages.yml` in `oesterer/piedmontpost`. Ensure its previous combined indexing workflow and `archive-search/` directory are removed. Keep **Settings → Pages → Source → GitHub Actions**. The site URL changes to **https://oesterer.github.io/piedmontpost/**; update Wix links/iframes.
3. Create a fine-grained personal access token limited to the **public website repository only**, granting **Contents: read/write**. The token's user must have repository write access. Store it in the indexing repository as the Actions repository secret **`SEARCH_SITE_TOKEN`**. It is used only for checking out and pushing the website repo. A short-lived GitHub App installation token with equivalent permission can replace this arrangement later.
4. Add the Actions repository secret **`PIEDMONT_ARCHIVE_PASSWORD`** in the indexing repository. This is the only password used to access the Wix archive. No hosting credentials are needed. Secrets left in the old public repository are no longer used by these workflows and can be removed after migration.
5. Optionally set indexing repository variables **`SEARCH_SITE_REPOSITORY`** (default: `<indexing-repo-owner>/piedmontpost`) and **`SEARCH_SITE_BRANCH`** (default: `main`). The public Pages workflow's push filter assumes `main`; update it if the website's default branch differs.
6. Ensure repository policy allows the indexing workflow's built-in token to commit cache changes to its default branch. The public website token must be permitted to push its branch too. If branch protections block direct pushes, explicitly arrange a permitted automation identity or adapt to a PR workflow; no force pushes are performed.
7. Enable Actions in both repositories. In the indexing repository, run **Actions → Update newspaper search → Run workflow**. Leave **rebuild unchecked** and **publish checked**. Confirm the Wix login succeeds, the private cache commit is saved, and a public index commit starts **Deploy search website** in the website repository. Test the new root site URL.
8. Configure maintainers' GitHub notification preferences for failures in **both** repositories. This workflow reports indexing/verification/public push status; the separate Pages run reports actual deployment status. It does not send custom email or Slack messages.

A repository's built-in `GITHUB_TOKEN` cannot push to the other repository. Using a separate repository-scoped PAT also ensures its public push triggers the website's Pages workflow. No indexing workflow is needed in the website repository and no Pages permissions are needed in the indexing repository.

## Staff operation

Staff upload the PDF, update the dated archive link in Wix, and publish their Wix changes. Routine indexing happens automatically. For an immediate run, bookmark **Update newspaper search** in the private indexing repository and choose **Run workflow**. GitHub repository write access is required, but no local software or command line is needed.

**rebuild** normally stays unchecked. It re-downloads/re-extracts all discovered PDFs and can take substantially longer. **publish** normally stays checked. Unchecking it tests and commits cache updates privately without changing the public indexes. A later scheduled run generates and publishes the pending changes.

To republish a site after a Pages failure, run **Deploy search website** in the public repository; reindexing PDFs is unnecessary.

## Schedule and processing

Cron times use UTC:

- Daily at 15:17 UTC: **08:17 PDT / 07:17 PST**, including the Thursday fallback.
- Wednesdays at 16:17–23:17 UTC plus Thursdays at 00:17–02:17 UTC: hourly on Wednesday **09:17–19:17 PDT / 08:17–18:17 PST**.

GitHub may delay scheduled runs. The hosted job uses macOS for Swift/PDFKit and installs Playwright Chromium automatically, so staff machines can use any OS. Private macOS runner usage can incur GitHub charges; set a billing budget and adjust frequency if needed. Public-repository schedules can be disabled after 60 days without activity; a private indexing repo avoids that particular public-repository behavior.

Each run checks out both repositories, tests the frontend from the public checkout, discovers issues, processes only new/missing PDFs, generates the indexes, and verifies all output against cache. The cutoff for quarterly files is calculated automatically in Los Angeles time; no weekly configuration edits are needed.

After successful verification, cache progress is committed privately. If indexing succeeded and publishing is enabled, only generated `manifest.json` and referenced JSON/compression sidecars are copied into the website checkout. Existing frontend files and older immutable index generations remain untouched. If files changed, the job commits and pushes them with `SEARCH_SITE_TOKEN`. That public commit triggers Pages. If nothing changed, no public commit or deployment occurs.

Private cache commits do not trigger another indexing run: the indexer has only scheduled/manual triggers. Its default token is scoped to the indexing checkout; the website checkout uses the separately scoped token.

## Recovery and concurrency

Only one indexing workflow runs at a time. A separate Pages concurrency group serializes website deployments. Avoid pushing to either default branch during an active update; a concurrent human commit can cause a safe push rejection. Rerun against the newest branches if that happens; no forced history replacement is attempted.

If some PDFs fail, verified private cache progress is saved, the workflow ends red, and public indexes are left unchanged. The next normal run retries missing issues. If verification fails, generated changes are not saved or published. If the public push fails, the private cache is already saved; the next run regenerates and retries the publication. If the public push succeeds but Pages fails, rerun the website deployment workflow and inspect its log.

If login/discovery fails, production remains available. Check whether the archive password or Wix layout changed. Renew the repository PAT before it expires; set an expiry reminder. Never embed these secrets in a public update button or browser code.

## Git history

Moving files does not erase their history from the original public repository. Older cache data and scripts remain in its existing commits unless a separate history cleanup is performed. Published search indexes are intentionally public regardless of where the private cache lives. Large full rebuilds grow private Git history, whereas ordinary weekly updates add small per-issue files. Never combine the cache into one enormous JSON file.
