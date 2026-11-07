# Run a complete update from your Mac

`npm run update:local` updates both local Git repositories, runs incremental indexing and verification, commits the cache, copies generated data to the public checkout, and pushes the public index update. It replaces the indexing job's execution on GitHub; the public repository still uses its separate GitHub Pages deployment workflow.

## Before the first run

Use macOS with Swift/PDFKit, Node.js 22+, Git and Google Chrome installed. Keep the repositories side by side, or specify the public checkout with `--site-dir` / `SEARCH_SITE_DIR`.

Both checkouts must be on their default branches (`main` is the fallback when the local `origin/HEAD` reference is unavailable). Commit **and push** code/documentation changes before running the updater. It refuses tracked/staged edits, pre-existing untracked generated data, and local commits that have not been pushed. It does not stash, rebase or force-push existing work. Unrelated untracked helpers such as `resume.sh` are left alone.

Configure your usual Git name/email and push credentials for both repositories. The script uses your existing Git authentication, not the CI-only `SEARCH_SITE_TOKEN`. You must be able to push to both branches under their branch-protection rules.

Commit and push the new updater script and package command before its first use; otherwise the clean-working-tree check will stop it.

## Normal weekly update

From `piedmontpost_indexing`:

```sh
npm run update:local
```

Enter the Wix archive password at the hidden prompt. Alternatively supply `PIEDMONT_ARCHIVE_PASSWORD` through your environment. The password is not written to Git.

This uses installed Chrome by default. If dependencies are missing or the lockfile changed during the Git update, it runs `npm ci` automatically.

For an alternative public checkout:

```sh
npm run update:local -- --site-dir /absolute/path/to/piedmontpost
```

To re-extract every discovered PDF:

```sh
npm run update:local -- --rebuild
```

To use Playwright's own Chromium instead of installed Chrome:

```sh
npx playwright install chromium
npm run update:local -- --browser-channel ""
```

Get the available flags with `npm run update:local -- --help`.

## Sequence

1. Acquire `cache/local-update.lock` and check that another indexer is not already running.
2. Check the repository roots, default branches, Git author configuration and working files.
3. Fetch both repositories from `origin`. Refuse pre-existing local commits and fast-forward both local branches to their remote versions.
4. Install dependencies if needed, then run the complete test suite against the public search checkout.
5. Run `index:archive` with Chrome. A normal update processes new/missing PDFs and previously failed refreshes; `--rebuild` refreshes every discovered issue.
6. Run `verify:indexes`. Verification must succeed before cache changes are committed.
7. Commit and push only `cache/manifest.json` and `cache/issues/` in the indexing repository. Use your configured Git identity.
8. If indexing reported any failure, stop here with an error. Verified cache progress is saved and the public repository remains unchanged.
9. Refresh the still-clean public checkout again, since another writer may have pushed during the indexing run.
10. Run `publish:site` to copy JSON indexes and the manifest into the public checkout.
11. Commit and push only `manifest.json` and `indexes/`. If nothing changed, skip the public commit/push. A changed public push triggers its Pages deployment.
12. Release the local updater lock.

The script runs without asking for separate approval at each push. Running this command means performing the complete update and publication sequence. It never stages frontend code, scripts, documentation, sample PDFs, or unrelated files as part of its generated-data commits.

## Failures and recovery

| Failure | Result / next action |
|---|---|
| Uncommitted tracked work or existing untracked generated data | Stops before fetching. Review and commit/stash/remove those changes as appropriate, then retry. |
| Existing unpushed commit or diverged branch | Stops before merging/pushing it. Reconcile and push your existing work first. |
| Tests fail | Stops before PDF processing and before generated-data commits. Fix the reported failure. |
| Some PDFs fail but verification succeeds | Saves verified cache progress, exits with failure and leaves the public repo unchanged. Rerun `update:local` to retry missing/flagged issues. |
| Verification fails | Leaves cache/output changes available for inspection without committing or publishing. Resolve the failure and review the working tree before retrying. |
| Git rejects a cache/public push | Stops; the local commit is retained. Reconcile that repository with the remote and push it; no force push is attempted. |
| Pages deployment fails after the public push | The local update has already completed. Inspect/rerun `Deploy search website` in the public repository. |

For a rejected push caused by a concurrent remote commit, inspect the affected checkout, then use the normal reconciliation workflow if appropriate:

```sh
git pull --rebase origin main
# Resolve any conflicts and continue the rebase if necessary.
git push origin main
```

This recovery is deliberately manual: automatically merging generated manifests and cached text can pick the wrong generation. The updater refreshes the public branch just before copying to reduce conflicts, but another push can still race it. Its local lock cannot prevent a separate GitHub-hosted job from running.

The updater removes its lock on normal completion or a handled error. An abruptly killed process can leave `cache/local-update.lock` (and a child indexer's `cache/indexer.lock`). Confirm that those processes have stopped before removing stale locks. Neither lock is the newspaper text cache.

## Testing without publishing real data

`tests/update-local.test.mjs` uses temporary local bare Git repositories and mocked indexing commands. It checks fast-forward updates, data-only commits, no-op runs, partial failures, verification failure, dirty working trees, existing local commits, and concurrent push rejection. It does not download PDFs, modify the real website checkout, or push to GitHub.
