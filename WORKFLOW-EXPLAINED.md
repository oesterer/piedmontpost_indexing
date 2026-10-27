# The indexing workflow, explained line by line

This guide explains every physical line of [`.github/workflows/update-search.yml`](.github/workflows/update-search.yml), including comments, blank lines, and the shell commands embedded inside YAML. It describes the file as it exists on **October 27, 2026**. Line numbers can change when the workflow is edited.

This is the **indexing workflow** in `piedmontpost_indexing`. The public repository’s `deploy-pages.yml` is a different workflow: a successful public push from this one starts that deployment. The distinction is why an indexing job can finish successfully while a later Pages deployment fails separately.

## Read these four layers separately

1. **YAML structure** uses indentation, `key: value` mappings, and `-` list items. Indentation establishes ownership: a step’s `env:` belongs to that step; the job’s `env:` belongs to the whole job. Blank lines are only spacing. `#` starts a YAML comment outside quoted values and multiline strings.
2. **GitHub Actions settings** give meaning to keys such as `on`, `jobs`, `uses`, `with`, and `run`. `uses:` calls a reusable action; `run:` executes a shell command. These are not interchangeable.
3. **Actions expressions** such as `${{ secrets.SEARCH_SITE_TOKEN }}` are evaluated by GitHub in the supported context before being passed to the action or shell. In an `if:` condition, the expression delimiters are usually optional. `&&` means AND, `||` means OR/fallback, `==` compares values, and `format` substitutes placeholders such as `{0}`.
4. **Bash commands** appear under `run:`. `$NAME` expands an environment variable; `if … then … else … fi` is shell control flow; `>>` appends output to a file. `${NAME:-fallback}` is Bash syntax, distinct from Actions’ `${{ … }}` syntax.

`run: |` introduces a literal multiline YAML string. The indented lines that follow are its shell-script contents; their `if`, `else`, `fi`, quotes and redirections are interpreted by Bash.

In the tables below, leading spaces from the original YAML are omitted for readability. Each source line is reproduced unchanged apart from that indentation and Markdown escaping.

## The runner filesystem

GitHub creates a fresh workspace for the job. The two checkout steps build this layout:

```text
$GITHUB_WORKSPACE/
├── indexer/                 # piedmontpost_indexing checkout
│   ├── package.json
│   ├── scripts/
│   ├── tests/
│   ├── cache/               # tracked incremental state
│   └── output/              # generated locally, ignored by Git
└── site/                    # piedmontpost checkout
    ├── index.html
    ├── app.js
    ├── manifest.json
    └── indexes/
```

Most shell steps start in `indexer`. The public Git-push step explicitly switches to `site`. `SEARCH_SITE_DIR` lets the Node scripts access that second checkout without changing the shell’s working directory.

## Lines 1–18: Name, manual controls and schedule

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 1 | `name: Update newspaper search` | Sets the friendly workflow name displayed in GitHub’s Actions tab. It does not name a program or a Git branch. |
| 2 | *(blank)* | Visual separation only; this line has no effect on execution. |
| 3 | `on:` | Starts the event definitions: these determine when GitHub creates a workflow run. |
| 4 | `workflow_dispatch:` | Enables a manual **Run workflow** button. There is no push trigger in this file. |
| 5 | `inputs:` | Defines the controls displayed when someone starts a manual run. |
| 6 | `rebuild:` | Names the first manual input `rebuild`. Later expressions read it as `inputs.rebuild`. |
| 7 | `description: Re-download and re-extract every issue (normally leave unchecked)` | Explains the rebuild checkbox to the person starting the job. This description is display text, not executable logic. |
| 8 | `type: boolean` | Makes `rebuild` a Boolean checkbox with the values true or false. |
| 9 | `default: false` | Leaves rebuild unchecked by default, so ordinary runs process only new/missing issues and failed refreshes. |
| 10 | `publish:` | Names the second manual input `publish`. This controls whether the public repository is updated. |
| 11 | `description: Push validated indexes to the public search repository` | Explains that publishing means pushing generated indexes to the public repository. The actual Pages deployment is a separate workflow. |
| 12 | `type: boolean` | Makes `publish` another Boolean checkbox. |
| 13 | `default: true` | Checks publish by default for a manual run. |
| 14 | `schedule:` | Starts the list of scheduled triggers, separate from the manual trigger. |
| 15 | `# Fixed PST (UTC-8): Wednesday 10:00, 14:00, and 23:00.` | A YAML comment documenting the intended fixed-PST clock times. Comments do not execute. |
| 16 | `# The final run falls on Thursday in UTC, but Wednesday in PST.` | Explains why one UTC cron entry uses Thursday even though the intended PST day is Wednesday. |
| 17 | `- cron: '0 18,22 * * 3'` | Schedules minute 0 of hours 18 and 22 on UTC weekday 3 (Wednesday), on any day of the month and in any month. These become Wednesday 10 a.m. and 2 p.m. at UTC−8. |
| 18 | `- cron: '0 7 * * 4'` | Schedules Thursday at 07:00 UTC. Subtracting eight hours gives Wednesday at 11 p.m. PST. There is no daily fallback schedule anymore. |

## Lines 19–25: Token permissions and concurrency

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 19 | *(blank)* | Visual separation only; this line has no effect on execution. |
| 20 | `permissions:` | Starts the permissions configuration for this workflow’s built-in `GITHUB_TOKEN`. |
| 21 | `contents: write` | Allows that token to read and write repository contents in the indexing repository, including committing the cache. It does not authorize access to the separate public repository; `SEARCH_SITE_TOKEN` does that. |
| 22 | *(blank)* | Visual separation only; this line has no effect on execution. |
| 23 | `concurrency:` | Starts concurrency settings to prevent overlapping runs from updating the same cache at once. |
| 24 | `group: newspaper-search-update` | Places every run of this workflow in the same repository-scoped concurrency group. A group name is a coordination key, not a branch or directory. |
| 25 | `cancel-in-progress: false` | Keeps the currently running job alive when another run is requested. With the default pending-queue behavior, a newer waiting run can replace an older waiting run; this is not an unlimited first-in-first-out queue. |

## Lines 26–39: Job, runner and shared variables

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 26 | *(blank)* | Visual separation only; this line has no effect on execution. |
| 27 | `jobs:` | Starts the mapping of jobs. Jobs get their own execution environments; this file defines one job. |
| 28 | `update:` | Names the job `update`. Its indented properties define where and how it runs. |
| 29 | `if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)` | Runs the job only when the triggering Git ref is the repository’s default branch. `format` constructs a full ref such as `refs/heads/main`; a manual run selected on another branch is skipped. |
| 30 | `runs-on: macos-15` | Requests a GitHub-hosted macOS 15 runner. macOS is needed because the extractor uses Apple’s Swift/PDFKit. |
| 31 | `timeout-minutes: 120` | Limits the entire job to 120 minutes. This is independent of the per-PDF download timeout configured inside the Node script. |
| 32 | `defaults:` | Starts default settings for the job’s steps. |
| 33 | `run:` | Limits these defaults to shell-command steps using `run:`. It does not relocate `uses:` actions. |
| 34 | `working-directory: indexer` | Makes shell commands run in the indexing checkout at `$GITHUB_WORKSPACE/indexer`. Checkout creates this folder before the first shell step. |
| 35 | `env:` | Starts job-wide environment variables available to its steps. |
| 36 | `SEARCH_SITE_DIR: ${{ github.workspace }}/site` | Builds an absolute path to the website checkout and puts it in `SEARCH_SITE_DIR`. The Node scripts and browser tests use this path instead of assuming the site is inside the indexing repository. |
| 37 | `SITE_REPOSITORY: ${{ vars.SEARCH_SITE_REPOSITORY \|\| format('{0}/piedmontpost', github.repository_owner) }}` | Uses the configured Actions variable `SEARCH_SITE_REPOSITORY`, or defaults to `<repository-owner>/piedmontpost` when it is empty. For owner `oesterer`, the fallback is `oesterer/piedmontpost`. |
| 38 | `SITE_BRANCH: ${{ vars.SEARCH_SITE_BRANCH \|\| 'main' }}` | Uses the configured website branch variable, or the string `main` when no value is provided. |
| 39 | `PUBLISH: ${{ github.event_name == 'schedule' \|\| inputs.publish }}` | Makes scheduled runs publish automatically; manual runs use the publish checkbox. The evaluated Boolean is placed in the environment as text, which is why later conditions compare it with the string `true`. |

## Lines 40–53: First checkout and configuration checks

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 40 | `steps:` | Starts the ordered list of steps. Steps within this job run in sequence and share its filesystem; each shell step still starts a new shell process. |
| 41 | `- name: Check out indexing repository` | Starts a step and gives it a readable label for the Actions log. |
| 42 | `uses: actions/checkout@v6` | Runs the reusable official checkout action, major version 6. This downloads the indexing repository; it is an action reference, not a shell command. |
| 43 | `with:` | Starts the input parameters passed to that action. |
| 44 | `ref: ${{ github.event.repository.default_branch }}` | Checks out the indexing repository’s default branch explicitly. |
| 45 | `path: indexer` | Places that checkout in a folder named `indexer`, relative to the runner workspace. This matches the shell working directory set on line 34. |
| 46 | `- name: Check configuration` | Starts the configuration-checking step. |
| 47 | `env:` | Defines environment variables only for this step, rather than exposing them to every shell command in the job. |
| 48 | `PIEDMONT_ARCHIVE_PASSWORD: ${{ secrets.PIEDMONT_ARCHIVE_PASSWORD }}` | Retrieves the archive password from the indexing repository’s Actions secrets and makes it available to this shell. The value is not written into the YAML. |
| 49 | `SEARCH_SITE_TOKEN: ${{ secrets.SEARCH_SITE_TOKEN }}` | Retrieves the separate token used to read and update the public website repository. This line only checks its presence; checkout receives it separately below. |
| 50 | `run: \|` | Introduces a literal multiline string. The following indented lines are Bash commands, not additional YAML settings. |
| 51 | `test -n "$PIEDMONT_ARCHIVE_PASSWORD" \|\| { echo '::error::Set the PIEDMONT_ARCHIVE_PASSWORD repository secret.'; exit 1; }` | Checks that the archive password is nonempty. If the check fails, the shell runs the grouped commands after `\|\|`: print a GitHub error annotation and exit with status 1. The password value is never printed. |
| 52 | `test -n "$SEARCH_SITE_TOKEN" \|\| { echo '::error::Set SEARCH_SITE_TOKEN with Contents read/write permission on the public repository.'; exit 1; }` | Performs the same nonempty check for the cross-repository token. It checks that a value exists, not that GitHub will accept its permissions or expiry. |
| 53 | `git ls-files --error-unmatch cache/manifest.json >/dev/null \|\| { echo '::error::Commit the incremental cache first.'; exit 1; }` | Checks that `cache/manifest.json` is tracked in the indexing checkout. `--error-unmatch` fails when it is not tracked; `>/dev/null` discards ordinary output. On failure, an annotation explains that the cache must be committed. This does not validate every issue file; later processing/verification does that. |

## Lines 54–69: Public checkout, Node, browser and tests

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 54 | `- name: Check out public search repository` | Starts the checkout step for the second repository. |
| 55 | `uses: actions/checkout@v6` | Uses checkout version 6 again. This invocation has different inputs and credentials from the first checkout. |
| 56 | `with:` | Starts this checkout action’s inputs. |
| 57 | `repository: ${{ env.SITE_REPOSITORY }}` | Selects the public repository using the value calculated on line 37. |
| 58 | `ref: ${{ env.SITE_BRANCH }}` | Selects the website branch calculated on line 38. |
| 59 | `path: site` | Creates a sibling checkout at `$GITHUB_WORKSPACE/site`; it is not nested inside `indexer`. |
| 60 | `token: ${{ secrets.SEARCH_SITE_TOKEN }}` | Authenticates this checkout with `SEARCH_SITE_TOKEN`. Checkout configures credentials for later Git operations in this repository, allowing the public push on line 108. |
| 61 | `- uses: actions/setup-node@v6` | Starts an unnamed step running the official setup-node action, major version 6. |
| 62 | `with:` | Starts the setup-node inputs. |
| 63 | `node-version: '22'` | Installs/selects Node.js 22 for `npm` and the indexing scripts. This is separate from the Node runtime that GitHub uses internally to execute an action. |
| 64 | `cache: npm` | Enables caching of npm’s downloaded package data. It does not store the newspaper cache or preserve `node_modules` as the application’s durable state. |
| 65 | `cache-dependency-path: indexer/package-lock.json` | Uses the indexing repository’s lockfile to calculate the npm cache key. This path is relative to the workspace for this action, so it includes `indexer/`. |
| 66 | `- run: npm ci` | Installs exactly the dependencies recorded in the lockfile. This shell command runs in `indexer` because of line 34; unlike a general `npm install`, `npm ci` requires a consistent lockfile. |
| 67 | `- run: npx playwright install chromium` | Downloads the Chromium browser version required by the installed Playwright package. The automation uses it to open the Wix archive. |
| 68 | `- name: Run tests against public search checkout` | Names the next test step. Some tests load real browser code from the separate public checkout. |
| 69 | `run: npm test` | Runs the `test` script in `package.json`: Node’s test runner executes `tests/*.test.mjs`. A normal test failure stops subsequent ordinary steps. |

## Lines 70–81: Indexing and rebuild selection

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 70 | `- name: Discover and index online issues` | Names the PDF discovery and extraction step. |
| 71 | `id: index` | Gives this step the machine-readable identifier `index`. Later conditions use `steps.index.outcome`; this identifier is independent of the visible name. |
| 72 | `continue-on-error: true` | Allows subsequent steps to continue after this step fails, so verified partial progress can still be saved. The original failure remains visible through `steps.index.outcome`; it is not treated as a successful indexing operation for publication. |
| 73 | `env:` | Starts the environment settings scoped to the indexing step. |
| 74 | `PIEDMONT_ARCHIVE_PASSWORD: ${{ secrets.PIEDMONT_ARCHIVE_PASSWORD }}` | Supplies the Wix archive password again, this time to the actual indexer. Environment variables from the earlier checking step do not automatically carry into this step. |
| 75 | `REBUILD: ${{ inputs.rebuild == true }}` | Converts the manual rebuild checkbox into a true/false environment value. On a scheduled run there is no checked manual input, so this is false. |
| 76 | `run: \|` | Starts a multiline Bash script that chooses between incremental indexing and a full rebuild. |
| 77 | `if [ "$REBUILD" = true ]; then` | Tests whether the `REBUILD` environment string is exactly `true`. Spaces inside the shell test brackets are required. Quotes keep the value a single argument. |
| 78 | `npm run index:archive -- --rebuild` | Invokes the package’s `index:archive` script with `--rebuild`. The first `--` tells npm to pass subsequent arguments to the script. The indexer refreshes every discovered issue. |
| 79 | `else` | Starts the alternative branch of the shell conditional. |
| 80 | `npm run index:archive` | Invokes normal incremental indexing. Successfully cached issues are skipped; new/missing issues and cached issues carrying `refreshFailure` are retried. |
| 81 | `fi` | Closes the Bash `if` statement. `fi` is shell syntax, not YAML or JavaScript. |

## Lines 82–94: Verification and saving the private cache

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 82 | `- name: Verify generated indexes` | Names the verification step. The indexer has already generated its JSON output before this step runs. |
| 83 | `id: verify` | Gives this step the identifier `verify`, used when deciding whether cache progress may be committed. |
| 84 | `run: npm run verify:indexes` | Runs the verifier defined in `package.json`. It compares generated pages, titles and source URLs with the persistent cache, and checks counts, hashes and index organization. |
| 85 | `- name: Save verified incremental cache` | Names the step that persists the incremental cache to the indexing repository. |
| 86 | `if: always() && steps.verify.outcome == 'success'` | Runs this step whenever verification actually succeeded, even if a preceding step failed. `always()` removes the normal success-only gate; the explicit verification condition still has to pass. It cannot recover a runner that has already stopped. |
| 87 | `run: \|` | Starts the shell script for configuring Git identity, staging cache files, and pushing changes. |
| 88 | `git config user.name 'github-actions[bot]'` | Sets the commit author name in this checkout’s Git configuration. It does not authenticate Git or grant permissions. |
| 89 | `git config user.email '41898282+github-actions[bot]@users.noreply.github.com'` | Sets the matching commit email. Authentication still comes from the credentials configured by the first checkout. |
| 90 | `git add cache/manifest.json cache/issues` | Stages the cache manifest and per-issue directory, including additions, edits and tracked deletions in those paths. Generated `output/` and frontend files are not staged here. |
| 91 | `if ! git diff --cached --quiet; then` | Runs the block only when staged changes exist. `git diff --cached --quiet` exits 0 for no staged difference and 1 for a difference; `!` reverses that result. |
| 92 | `git commit -m "Update newspaper issue cache [skip ci]"` | Creates the private cache commit. `[skip ci]` is a commit-message instruction understood by some push/PR workflows; this indexing workflow has only scheduled/manual triggers anyway. |
| 93 | `git push origin "HEAD:$GITHUB_REF_NAME"` | Pushes the current commit (`HEAD`) to the triggering branch name on `origin`, using the indexing checkout’s built-in token. The job-level branch guard makes this the default branch. A conflicting remote push is rejected; there is no force flag. |
| 94 | `fi` | Closes the shell conditional. With no staged changes, no commit or push occurs. |

## Lines 95–112: Publishing to the public repository

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 95 | `- name: Copy generated indexes to public repository` | Names the step that copies generated data to the public website checkout. |
| 96 | `if: steps.index.outcome == 'success' && env.PUBLISH == 'true'` | Requires a genuinely successful indexing step and publishing enabled. GitHub also applies its usual success gate because this expression does not contain a status function, so an earlier verification or cache-push failure blocks it. |
| 97 | `run: npm run publish:site` | Runs `scripts/sync-site.mjs` through the package script. It validates and copies JSON indexes and the manifest into `SEARCH_SITE_DIR`, leaves frontend code and older JSON generations in place, and removes obsolete compressed sidecars. It does not push by itself. |
| 98 | `- name: Push updated public indexes (triggers Pages deployment)` | Names the separate Git commit/push step for the website repository. |
| 99 | `id: publish` | Gives this step the identifier `publish`. Its outputs will be read when producing the run summary. |
| 100 | `if: steps.index.outcome == 'success' && env.PUBLISH == 'true'` | Repeats the successful-indexing and publishing-enabled conditions. The ordinary success gate also prevents a push after the copy step fails. |
| 101 | `working-directory: site` | Overrides the default shell working directory for this step. `site` is resolved relative to the workspace, so these Git commands operate in the public checkout, not `indexer/site`. |
| 102 | `run: \|` | Starts the multiline public-repository Git script. |
| 103 | `git config user.name 'github-actions[bot]'` | Sets the author name for commits in the public checkout. Git configuration from the indexing checkout does not configure this separate repository. |
| 104 | `git config user.email '41898282+github-actions[bot]@users.noreply.github.com'` | Sets the corresponding commit email in the public checkout. |
| 105 | `git add manifest.json indexes` | Stages only `manifest.json` and the `indexes` directory, including any removed compressed files. It deliberately excludes HTML, JavaScript, CSS and workflow changes from this indexing commit. |
| 106 | `if ! git diff --cached --quiet; then` | Checks for staged changes, using the same inverted quiet-diff test as line 91. A no-change run does not create an empty public commit. |
| 107 | `git commit -m "Update newspaper search indexes"` | Commits the updated public data. There is no `[skip ci]` here, because this push should trigger the public Pages workflow. |
| 108 | `git push origin "HEAD:$SITE_BRANCH"` | Pushes the public checkout’s current commit to `SITE_BRANCH` on its own `origin`, using the separately configured `SEARCH_SITE_TOKEN`. A successful relevant push starts the public repository’s Pages workflow; it does not prove that deployment has finished. |
| 109 | `echo 'changed=true' >> "$GITHUB_OUTPUT"` | Appends a step output called `changed` with string value `true` to GitHub’s special output file. Later steps can read it as `steps.publish.outputs.changed`. |
| 110 | `else` | Starts the no-staged-changes branch. |
| 111 | `echo 'changed=false' >> "$GITHUB_OUTPUT"` | Writes `changed=false` as the step output. This branch does not commit or push, so it starts no Pages deployment. |
| 112 | `fi` | Closes the public-push conditional. |

## Lines 113–125: Run summary

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 113 | `- name: Write run summary` | Names the step that builds a human-readable run summary. |
| 114 | `if: always()` | Attempts the summary step regardless of previous success or failure, rather than using the ordinary success-only gate. A terminated/unavailable runner can still prevent execution. |
| 115 | `env:` | Starts environment values used only by the summary shell script. |
| 116 | `INDEX_OUTCOME: ${{ steps.index.outcome }}` | Copies the raw indexing-step outcome into a shell variable. It may be `failure` even though that step had `continue-on-error: true`. |
| 117 | `VERIFY_OUTCOME: ${{ steps.verify.outcome }}` | Copies the verification-step outcome into another shell variable. |
| 118 | `PUBLISH_OUTCOME: ${{ steps.publish.outcome }}` | Copies the public commit/push step’s outcome. It is not the result of the separate Pages deployment. |
| 119 | `PUBLIC_CHANGED: ${{ steps.publish.outputs.changed }}` | Copies the `changed` output written on lines 109/111. If the publishing step never reached either line, this can be empty. |
| 120 | `run: \|` | Starts the summary-writing Bash script. |
| 121 | `echo '## Newspaper search update' >> "$GITHUB_STEP_SUMMARY"` | Appends a Markdown heading to GitHub’s job-summary file. The `##` characters are inside quotes and therefore are part of the text, not a shell comment. |
| 122 | `echo "- Indexing: ${INDEX_OUTCOME:-not run}" >> "$GITHUB_STEP_SUMMARY"` | Appends an indexing-status bullet. `${INDEX_OUTCOME:-not run}` is Bash parameter expansion: use `not run` when the variable is unset or empty. |
| 123 | `echo "- Verification: ${VERIFY_OUTCOME:-not run}" >> "$GITHUB_STEP_SUMMARY"` | Appends the verification-status bullet with the same unset/empty fallback. |
| 124 | `echo "- Public repository update: ${PUBLISH_OUTCOME:-not run}; files changed: ${PUBLIC_CHANGED:-no}" >> "$GITHUB_STEP_SUMMARY"` | Appends the public push outcome and changed-files indicator. `PUBLIC_CHANGED` is true/false, not a count of files. If no output was written, the display fallback is `no`. |
| 125 | `echo "- Pages deployment runs separately in $SITE_REPOSITORY." >> "$GITHUB_STEP_SUMMARY"` | Appends a reminder that actual Pages deployment is a separate workflow in the named public repository. Double quotes let the shell expand `$SITE_REPOSITORY`. |

## Lines 126–130: Final failure status

| Line | YAML / shell source | Explanation |
|---:|---|---|
| 126 | `- name: Report indexing failure` | Names the final step that reports an indexing failure after partial-progress handling. |
| 127 | `if: always() && steps.index.outcome == 'failure'` | Runs only when the indexing step’s original outcome was failure. `always()` ensures earlier failures do not hide this check. If indexing never ran, this particular failure-reporting step is skipped. |
| 128 | `run: \|` | Starts the final shell script. |
| 129 | `echo '::error::Indexing failed. Verified cache progress was saved if available; public indexes were not changed. Rerun to retry missing issues.'` | Prints a GitHub error annotation explaining the failed indexing run. Cache progress is saved only if verification passed and the cache save/push succeeded; the message does not override those earlier requirements. |
| 130 | `exit 1` | Exits with failure status so a failed indexing run ends red, despite the earlier `continue-on-error`. Successful indexing does not execute this step. |

## Cron: reading the five fields

The workflow uses standard five-field cron expressions interpreted in UTC because it declares no schedule timezone:

```text
minute  hour   day-of-month  month  day-of-week
0       18,22  *             *      3
0       7      *             *      4
```

`*` means every value for that field. `18,22` means two hours, not a range. `3` is Wednesday and `4` is Thursday. Fixed PST is UTC−8, so Thursday 07:00 UTC is still Wednesday 23:00 PST. During daylight saving time the local Pacific clock times shift; these entries are not an America/Los_Angeles daylight-saving schedule. GitHub scheduled runs are approximate and can be delayed.

## The values that look similar but do different things

| Example | Type / scope | Meaning here |
|---|---|---|
| `name: Discover and index online issues` | Display name | Label shown to people in the log. |
| `id: index` | Step identifier | Key used by other steps to reference outcomes. |
| `inputs.publish` | Manual Boolean input | Checkbox selected when manually starting the workflow. |
| `env.PUBLISH` | Environment string | Job-wide publishing decision, compared with `'true'`. |
| `vars.SEARCH_SITE_REPOSITORY` | Repository configuration variable | Non-secret name of the public repository. |
| `secrets.SEARCH_SITE_TOKEN` | Secret | Credential used for the other repository. |
| `github.token` / built-in `GITHUB_TOKEN` | Automatic job credential | Used implicitly by the first checkout to push private cache updates. |
| `steps.index.outcome` | Raw execution status | Whether indexing really succeeded, failed, or was skipped. |
| `steps.index.conclusion` | Status after error handling | Can be `success` after a tolerated indexing failure. This file deliberately checks `outcome`. |
| `steps.publish.outputs.changed` | Custom step-output string | `true` or `false` written to `GITHUB_OUTPUT`. |
| `$GITHUB_OUTPUT` | Runner-provided file path | Append `key=value` here to define outputs for this step. |
| `$GITHUB_STEP_SUMMARY` | Runner-provided file path | Append Markdown here to show a formatted job summary. |

The `name`/`id` distinction also explains why renaming a visible step label does not break expressions, whereas changing `id: index` requires updating every `steps.index.…` reference.

## Why a tolerated failure still ends red

`continue-on-error: true` lets the workflow continue long enough to verify and save partial cache progress. It does not authorize publishing a partial update.

- **Line 72:** tolerate the immediate indexing-step failure so later work is possible.
- **Line 86:** save cache only if output verification passed.
- **Lines 96 and 100:** require the original indexing outcome to be `success` before touching the public repository.
- **Lines 127–130:** restore an overall failed result when indexing failed.

Ordinary steps and ordinary `if:` expressions also have an implicit success check. A condition that looks true can still be skipped after an earlier failure. `always()` deliberately changes that behavior for the cache-save, summary and final-reporting steps. This is why a failed verification or rejected cache push does not get bypassed by the publication condition.

## Trace three common runs

**No new PDFs:** tests pass; the indexer reuses cached issues; generated data is verified. If the cache and public data are unchanged, no commits are created and Pages is not triggered. Quarter rollover is an exception: regrouping weekly data can change public files without adding a PDF.

**One new issue:** the indexer downloads and extracts it, writes the per-issue cache and new JSON indexes, then verifies them. It commits cache changes in the indexing repository, copies the generated files into the public checkout, and pushes a public commit. That push starts the separate Pages deployment.

**Some PDFs fail:** the indexer preserves any usable old text, records retry information for failed cached refreshes, and generates output from the usable cache. If verification passes, cache progress can be saved. Public publication is skipped because `steps.index.outcome` is `failure`; the final reporting step makes the run red. A later normal run retries missing PDFs and flagged refreshes.

If a public push is rejected because someone else pushed first, there is no force push or automatic merge in this YAML. The verified private cache is already saved; a new run checks out the latest public branch and tries publication again.

## What YAML does not implement

This file orchestrates programs; it does not contain their PDF-processing algorithms. `package.json` maps the commands to these programs:

| Command | Program / role |
|---|---|
| `npm test` | Node test runner for `tests/*.test.mjs`. |
| `npm run index:archive` | `scripts/index-archive.mjs`: discover PDFs, retry downloads, use Swift extraction, maintain cache, and generate output. |
| `npm run verify:indexes` | `scripts/verify-indexes.mjs`: check output against the cache. |
| `npm run publish:site` | `scripts/sync-site.mjs`: validate/copy generated JSON to the website checkout and clean up legacy sidecars. |

The 10-second download timeout, two download retries, article-title detection, failed-refresh markers and automatic quarter calculation are in those programs. They are separate from the workflow’s 120-minute job limit and cron schedule. Git commits and pushes happen in the YAML’s shell steps, not inside `publish:site`.

The npm dependency cache is also separate from the Git-backed newspaper cache: losing npm’s cache merely makes dependency installation slower; the tracked newspaper cache is what avoids reprocessing successful PDFs.

## GitHub reference material

The line descriptions above are based on this repository’s actual YAML and package scripts. For the platform rules behind them:

- [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) defines jobs, steps, `run`, `uses`, default working directories, permissions and `continue-on-error`.
- [Expressions and status checks](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions) explains Boolean expressions and the implicit `success()` condition.
- [Concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency) explains serialization and pending-run behavior.
- [Workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands) explains error annotations, output files and job summaries.

Related project documents: [AUTOMATION.md](AUTOMATION.md) for operating the system and [SYSTEM-FLOW.md](SYSTEM-FLOW.md) for diagrams.

Workflow snapshot SHA-256: `d8a5ef70eced654a7f86f492f704d398876560b1123cda2030f02021911d7265`. This identifies the version explained here; update this guide if the workflow changes.
