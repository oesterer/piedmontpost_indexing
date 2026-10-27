# Automated newspaper indexing and publishing

The system has two independent GitHub Actions workflows. PDF processing runs in `piedmontpost_indexing`; deployment runs in `piedmontpost`. Readers search static files in their browser.

## System overview

```mermaid
flowchart TB
    Staff["Newspaper staff<br/>Upload PDF and publish archive link in Wix"]
    Wix["Wix archive<br/>Dated links and original PDFs"]
    Trigger["Scheduled or manual trigger<br/>Wednesday 10 am, 2 pm, 11 pm PST"]

    subgraph Private["piedmontpost_indexing — indexing repository"]
        Action["Update newspaper search<br/>GitHub-hosted Mac"]
        Cache[("Git-backed incremental cache<br/>Per-issue text, headlines, retry flags")]
        Generate["Generate and verify JSON indexes<br/>Completed quarters + current weekly issues"]
    end

    subgraph Public["piedmontpost — public website repository"]
        Data["manifest.json + indexes/<br/>Search HTML, JavaScript and CSS"]
        Deploy["Deploy search website<br/>Separate GitHub Pages workflow"]
    end

    Pages["Live static website<br/>oesterer.github.io/piedmontpost/"]
    Browser["Reader's browser<br/>Loads indexes progressively<br/>Searches in a Web Worker"]

    Staff --> Wix
    Trigger --> Action
    Wix -->|"Discover links; download needed PDFs"| Action
    Cache -->|"Reuse successful issues"| Action
    Action --> Generate
    Action -->|"Commit verified cache updates"| Cache
    Generate -->|"If successful, publishing enabled and files changed:<br/>push with SEARCH_SITE_TOKEN"| Data
    Data -->|"Relevant push or manual deployment"| Deploy
    Deploy --> Pages
    Pages --> Browser
    Browser -->|"Result opens original PDF at page number"| Wix
```

The schedule uses **fixed PST (UTC−8)**, not automatic daylight-saving adjustment. During PDT the same runs fall at Wednesday 11 am, Wednesday 3 pm, and Thursday midnight. GitHub may delay scheduled jobs. Publishing a Wix update does not directly trigger indexing; the next scheduled check or a manual run discovers it.

## Indexing workflow and failure paths

```mermaid
flowchart TD
    Start["Schedule or Run workflow"] --> Setup["Check out both repositories<br/>Check secrets and cache<br/>Install dependencies; run tests"]
    Setup --> SetupOK{"Setup and tests pass?"}
    SetupOK -->|"No"| Early["Run fails<br/>Public website stays unchanged"]
    SetupOK -->|"Yes"| Discover["Log into Wix<br/>Discover weekly PDF links"]
    Discover --> Select["Choose PDFs to process<br/>Normal: new, missing or failed refreshes<br/>Rebuild: all discovered issues"]
    Select --> Process["For each selected PDF:<br/>Download with 10-second timeout<br/>Up to 3 attempts total<br/>Extract page text and article titles"]
    Process --> PerPDF{"PDF processed successfully?"}
    PerPDF -->|"Yes"| Success["Save new per-issue cache<br/>Clear any failed-refresh flag"]
    PerPDF -->|"No"| Failed["Preserve older cached text if available<br/>Record failed-refresh flag<br/>Missing issues remain uncached"]
    Success --> More{"More selected PDFs?"}
    Failed --> More
    More -->|"Yes"| Process
    More -->|"No"| Generate["Build JSON indexes from usable cache<br/>Calculate last completed quarter<br/>Write manifest after index files"]
    Generate --> Verify{"All output matches cache?"}
    Verify -->|"No"| Invalid["Run fails<br/>Do not commit generated changes<br/>Do not publish"]
    Verify -->|"Yes"| Save["Commit verified cache changes<br/>to indexing repository"]
    Save --> CachePush{"Cache saved successfully?"}
    CachePush -->|"No"| PushError["Run fails<br/>Resolve push conflict and rerun<br/>No force push"]
    CachePush -->|"Yes"| IndexOK{"Indexing completed without errors?"}
    IndexOK -->|"No"| Retry["Run fails; do not update public indexes<br/>Next normal run retries failed issues"]
    IndexOK -->|"Yes"| Publish{"Publishing enabled?"}
    Publish -->|"No"| PrivateOnly["Finish with cache updates only"]
    Publish -->|"Yes"| Copy["Validate and copy generated JSON<br/>to public repository<br/>Preserve frontend and older JSON generations"]
    Copy --> Changed{"Public files changed?"}
    Changed -->|"No"| NoOp["Finish without public commit<br/>No deployment"]
    Changed -->|"Yes"| Push["Commit and push public indexes<br/>using SEARCH_SITE_TOKEN"]
    Push --> PublicPush{"Public push succeeded?"}
    PublicPush -->|"No"| PublicRetry["Indexing job fails<br/>Cache is already saved<br/>Next run retries publication"]
    PublicPush -->|"Yes"| Pages["Public repository starts<br/>Deploy search website"]
    Pages --> Upload["Package only public website files<br/>Upload artifact; deploy GitHub Pages"]
    Upload --> Deployed{"Pages deployment succeeded?"}
    Deployed -->|"Yes"| Live["Readers receive updated search"]
    Deployed -->|"No"| DeployRetry["Separate Pages workflow fails<br/>Rerun Deploy search website<br/>No PDF reindexing needed"]
```

Exceptional discovery, extraction, or generation failures stop the relevant stage. Verification cannot make a failed indexing step publish: publication additionally requires indexing success. Copy/validation failures also stop publication before a public push.

## Repository ownership and credentials

| Component | Owner / location | Purpose |
|---|---|---|
| PDFs and archive links | Wix | Staff publishing and original documents |
| Indexing scripts and tests | `piedmontpost_indexing` | Discovery, extraction, grouping and validation |
| Incremental cache | `piedmontpost_indexing/cache/` | Avoid repeat processing and remember failed refreshes |
| Generated output | Ignored `piedmontpost_indexing/output/` | Temporary publication data |
| Public search files | `piedmontpost` root | Browser search, manifest and JSON indexes |
| Archive password | Indexer secret `PIEDMONT_ARCHIVE_PASSWORD` | Automated Wix login |
| Cross-repository token | Indexer secret `SEARCH_SITE_TOKEN` | Read/write public repository contents and trigger its push workflow |
| Private cache push | Built-in indexing workflow `GITHUB_TOKEN` | Commit cache without triggering another indexing job |
| Pages deployment | Public workflow's GitHub token and OIDC | Publish static website; no external host credentials |

Only one indexing job runs at a time. A separate concurrency group serializes Pages deployments. Successful private cache commits do not start another indexing run. Public pushes made with `SEARCH_SITE_TOKEN` trigger Pages normally.

The quarter cutoff is computed in **America/Los_Angeles**: during Q4 2026 it is September 30; from January 1, 2027 it becomes December 31. This calendar calculation is separate from the fixed-PST cron schedule. Quarter consolidation can change the public files even when no new PDF was added.

The browser initially loads the manifest and latest index, fetches older indexes as needed, and pauses after each batch of results. Full-text matching runs client-side. PDF links include `?page=N#page=N`; actual page navigation depends on the PDF viewer.

Source workflows: [indexing](.github/workflows/update-search.yml) and `../piedmontpost/.github/workflows/deploy-pages.yml`. Operational setup and recovery: [AUTOMATION.md](AUTOMATION.md).
