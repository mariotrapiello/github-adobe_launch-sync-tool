# Adobe Launch Reactor Sync

Bidirectional synchronisation of Adobe Launch (Tags) rules, data elements, and rule components with a Git repository.

Fork of [adobe/reactor-sync](https://github.com/adobe/reactor-sync) with the following changes:

- **OAuth 2.0 authentication** — the original JWT flow reached end-of-life on March 1, 2026. `bin/utils/getAccessToken.js` has been patched to use the `client_credentials` grant.
- **Single-property repo** — one repo per Launch property, under `properties/property1/` with its own settings file.
- **Filtered resource types** — only `data_elements`, `rules`, and `rule_components` are synced by default; extensions can be enabled with one line (see below).
- **Two operating modes** — draft mode (pull/diff/sync against Launch drafts) and environment mode (pull/diff/sync against a published environment, with automatic publishing after sync).

---

## Prerequisites

- [Conda](https://docs.conda.io/en/latest/miniconda.html) (Miniconda or Anaconda)
- An Adobe Developer Console project with **OAuth Server-to-Server** credentials and the Experience Platform Launch API added

---

## One-time setup

### 1. Create the Conda environment

```bash
conda env create -f environment.yml
conda activate prisa
npm install
```

This creates the `prisa` environment with Node.js 22 and installs all npm dependencies. All subsequent commands must run inside `conda activate prisa`.

### 2. Get credentials from Adobe Developer Console

1. Go to [https://developer.adobe.com/console](https://developer.adobe.com/console)
2. Open your project (or create one and add the Experience Platform Launch API)
3. Select **OAuth Server-to-Server** as the credential type
4. Assign product profiles that have Tags/Launch access
5. Copy **Client ID**, **Client Secret**, and **Organization ID** from the credential overview

### 3. Create `integration.json` (never commit this file)

The repo already contains `integration.config.json` (committed) with the non-sensitive configuration (scopes). You only need to create `integration.json` with your credentials:

```bash
cat > integration.json << 'EOF'
{
  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "orgId": "XXXXXXXXXXXXXXXX@AdobeOrg"
}
EOF
```

`integration.json` is gitignored — do not commit it. The scopes are in `integration.config.json` and are applied automatically.

### 4. Configure the property settings

Edit `properties/property1/reactor-settings.json` and replace the placeholder values with your real IDs:

```json
{
  "propertyId": "PRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "environment": {
    "reactorUrl": "https://reactor.adobe.io"
  },
  "environmentId": "ENxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

- **`propertyId`** — found in the Adobe Launch UI under your property's **Settings** tab (format: `PRxxxx...`).
- **`environmentId`** — found under **Environments** in your Launch property. Use the ID of the environment this branch should target (dev, staging, or production). If you are using draft mode only (no auto-publish), remove the `environmentId` line entirely.
- You can rename the `property1` folder to any meaningful name — just update the path in `.github/workflows/sync.yml` accordingly (`properties/<your-name>/reactor-settings.json`).

Commit `reactor-settings.json` — it contains no secrets, only IDs.

### 5. Do the initial pull

```bash
node bin/index.js pull --settings-path ./properties/property1/reactor-settings.json
```

This downloads all resources from your Launch property into `properties/property1/<propertyId>/` and creates the local file structure. Commit the result:

```bash
git add properties/property1/
git commit -m "feat: initial pull from Adobe Launch"
```

---

## Operating modes

### Draft mode (default)

In draft mode, `pull`/`diff`/`sync` operate against Launch's working copy (drafts). Publishing to a Launch environment is done manually from the Launch UI.

`reactor-settings.json` (draft mode — `main` branch):

```json
{
  "propertyId": "PRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "environment": { "reactorUrl": "https://reactor.adobe.io" }
}
```

### Environment mode

When `reactor-settings.json` contains an `environmentId` field, the tool switches to environment mode:

- **pull** reads resources from the last succeeded build of that environment (not drafts)
- **diff** compares your local files against the published resources in that environment
- **sync** pushes changes to drafts first, then automatically creates a library, builds it, and publishes it to the target environment

`reactor-settings.json` (environment mode — `dev`/`staging`/`prod` branch):

```json
{
  "propertyId": "PRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "environment": { "reactorUrl": "https://reactor.adobe.io" },
  "environmentId": "ENxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

#### Finding your environment ID

In the Launch UI: **Environments** tab → click the environment → the URL contains the `EN...` ID. Or use the Reactor API:

```
GET https://reactor.adobe.io/properties/{propertyId}/environments
```

#### Publish flow by environment type

The tool mirrors the **single-library promotion flow** of the Launch UI — one library travels through the full dev → staging → production chain. Each Git branch triggers only its own step in that chain:

| Git branch  | Environment type | What `sync` does                                                                                             |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `dev`       | Development      | Creates a fresh `git-sync-*` library, adds resources, triggers a dev build. Library stays in `development`. |
| `staging`   | Staging          | Finds the latest `git-sync-*` library in `development` state, submits it, builds for staging. Library stays in `submitted`. |
| `prod`      | Production       | Finds the latest `git-sync-*` library in `submitted` state, approves it, triggers the final production build.|

> **The gate rule:** If there is no `git-sync-*` library in the expected state, `sync` fails with a clear error. You cannot publish to staging without a prior dev publish, and you cannot publish to production without a prior staging publish.
>
> **Blocking rule:** If a `git-sync-*` library is already in `submitted` state when you try to run staging sync, the tool blocks and asks you to run prod sync first. This prevents overwriting a version that is pending production approval.

Build timeout: 120 seconds (polled every 5 s).

#### How the publish flow works internally

Understanding this flow is important if your team also works directly in the Launch UI.

**Development branch**

**Step 1 — Update the draft**

For each modified resource, `sync` updates its draft in Adobe Launch. Because the Reactor API requires resources to have a numbered revision before they can be added to a library, `sync` also calls `revise` after each update. This creates a clean, publishable revision (e.g. `revision_number: 1`).

> **Why IDs change:** Each `revise` call creates a brand-new resource ID in Launch. After a `sync + publish`, the IDs in your local files are stale. Always run `pull` after a successful `sync` to update your local copy to the new IDs from the latest build.

**Step 2 — Create a library and build**

Adobe Launch only allows **one library to be assigned to a given environment at a time**. The dev publish step always creates a **fresh `git-sync-<timestamp>` library** containing only your modified resources:

- If another library already has that environment assigned (e.g. a colleague opened one in the UI), the tool **unlinks the environment from that library** before proceeding. This does **not** delete that library or its resources — it only removes the environment link. The colleague's library is fully preserved.
- The environment is assigned to the new library and the dev build is triggered.

After a successful build the library stays in `development` state. It is intentionally **not** submitted here — this allows multiple dev syncs to be done freely without "Upstream blocked" conflicts. The submit step happens when the staging branch runs sync.

**Staging branch**

**Step 1 — Find the promoted library**

`sync` searches for the latest `git-sync-*` library in `development` state. If none is found, it exits with an error asking you to publish to development first. If a `git-sync-*` library is already in `submitted` state, it also blocks — you must run prod sync first to clear the pipeline.

**Step 2 — Submit, build for staging**

The library is submitted (moving it out of `development`), the staging environment is assigned, and the staging build is triggered. On success the library stays in `submitted` state — it is **not** approved here. The team does QA in staging, and approval happens in the next step.

**Production branch**

**Step 1 — Find the submitted library**

`sync` searches for the latest `git-sync-*` library in `submitted` state. If none is found, it exits with an error asking you to publish to staging first.

**Step 2 — Approve and final production build**

The library is approved (the QA sign-off, confirming staging was validated), the production environment is assigned, and the final build is triggered. On success the library is fully published.

---

#### Libraries, builds and environments — what you need to know

Adobe Launch's publishing model has some important constraints that affect how this tool works.

**How builds relate to environments**

A `build` is always tied to the library that created it, not to the environment directly. The environment just serves as the deployment target for that build. When you query `GET /environments/{id}/builds`, the API returns builds that were created *targeting* that environment.

**What happens when you delete a library**

If you delete a `git-sync-*` library from the Launch UI:
- The library and all its builds are permanently removed from the API
- The environment's deployed script (`launch-xxxxxx-development.min.js`) continues to work on the CDN — it is not deleted
- But the API loses all reference to the build that generated that script
- The next `pull` will print `[WARN] No succeeded build found` and fall back to reading drafts instead

**Consequence: do not delete git-sync-* libraries manually**

These libraries are the only record the API has of what is deployed to each environment. If you delete them, the link between the API and the deployed script is lost. The tool will still work (it falls back to draft mode for pull/diff), but:
- `pull` and `diff` will compare against drafts, not the actual deployed state
- `sync` will only create a new build when you have at least one locally modified resource

**How to recover from a deleted library**

If you accidentally deleted a library and the environment has no build:

1. Edit any resource locally (even a trivial change like a comment in a `.js` file)
2. Run `sync` — this will push the change, create a new `git-sync-*` library, build it, and restore the environment state
3. Run `pull` to refresh your local IDs to match the new build

You cannot restore the build by running `sync` with no local changes, because Adobe's API rejects adding resources that are already "upstream" (already published in a higher environment) to a new dev library.

**Why you see `[REVISE]` logs and what they mean**

When a resource has been published through the promotion chain (dev → staging → prod), its revision becomes frozen (read-only). Adobe's API rejects any `PATCH` on a frozen revision with `409 non-head revisions are frozen`.

The tool handles this automatically with a three-step fallback:

1. **First attempt**: tries to update the resource directly by its local ID.
2. **If frozen**: finds the latest "head" revision for that resource origin and tries to update that instead.
3. **If head is also frozen** (e.g. the resource is in a `submitted` or `published` library): calls `revise` to create a brand-new editable draft, then updates and revises it to produce a clean numbered revision.

This is why you may see logs like:
```
[REVISE]   Resource DEd155... is frozen. Finding/creating a new draft...
[REVISE]   Head revision DE5f6... is also locked. Creating new draft...
[REVISE]   Updating new draft: DEabc...
[REVISE]   New revision: DEdef...
```
This is expected behaviour — the tool is working correctly. The new revision ID is what gets added to the dev library.

**Multiple dev syncs — what happens to old libraries**

You can run dev sync as many times as you want. Each run:
- Creates a fresh `git-sync-<timestamp>` library with only the resources modified in that sync.
- If the dev environment was already assigned to an older library, **only the environment link is removed** from that library (the library itself is preserved). The new library then gets the environment assigned.

Old `git-sync-*` libraries in `development` state accumulate over time. They are harmless and can be deleted manually from the Launch UI if desired. The staging sync always picks the **most recently created** one.

**What happens if a library was manually submitted from the Launch UI**

If someone manually clicks "Submit for Approval" on a `git-sync-*` library from the Launch UI (skipping the staging sync), the prod sync will print a warning and exit cleanly:

```
⚠️  Cannot promote to production: library "git-sync-..." has not been built for a staging environment.
   Only libraries that went through staging can be promoted to production.
   Run sync on the staging branch first to build and validate in staging.
```

To recover: reject or delete that library manually from the Launch UI, then run the staging sync normally to promote the `development` library through the correct flow.

**Note on Launch API state filtering**

The `listLibrariesForProperty` endpoint in the Reactor API does not reliably filter by state server-side. All state filtering (`development`, `submitted`, `approved`, `published`) is applied client-side in the code after fetching the full list. This is a known API limitation.



A single `git-sync-*` library travels through the full promotion chain:

```
[dev branch sync]
  Creates git-sync-<timestamp> library
  → adds modified resources (revised)
  → builds for dev environment
  → library state: development  (stays here — multiple dev syncs allowed)

[staging branch sync]
  Finds git-sync-* library in development state
  → submits → library state: submitted
  → reassigns to staging environment
  → builds for staging
  → library state: submitted  (stays here — do QA in staging)

[prod branch sync]
  Finds git-sync-* library in submitted state
  → approves → library state: approved
  → reassigns to prod environment
  → builds for prod → library state: published
```

Each environment assignment overwrites the previous one on the library — the library only has one environment at a time. The build records which environment it was built for, so `pull` can still find the correct build for each environment even after the library has been promoted.

---

#### Recommended workflow in environment mode

```
── dev branch ──────────────────────────────────────────────
pull          ← get the current published state (1:1 copy)
  ↓
edit files    ← modify settings.json / .js files
  ↓
diff          ← verify the diff shows Modified (not Behind)
  ↓
sync          ← push to drafts + build in dev environment
  ↓
pull          ← refresh local IDs to match the new build

── merge dev → staging branch ──────────────────────────────
sync          ← promotes the library to staging (build + approve)

── merge staging → prod branch ─────────────────────────────
sync          ← promotes the library to production (final build)
```

The `pull` after dev sync is important: after publishing, Adobe assigns new revision IDs to all updated resources. Without pulling, subsequent `diff` runs will show those resources as `Added`.

#### What if someone changes Launch directly while I have a library open?

The tool detects conflicts before syncing:

- If a resource in Launch has been updated **after your last pull** (its remote revision is newer than what you have locally), `diff` will mark it as **Behind**.
- `sync` will not overwrite Behind resources. In CI mode (`--ci`), it exits with an error listing all conflicts.
- To resolve: run `pull`, review the changes, and push again.

This means: if a colleague edits a resource in the Launch UI while you are working locally, your next `sync` will catch the conflict before overwriting their work.

### Branch-per-environment strategy

The tool doesn't care about your git branch names. It only cares about the contents of `reactor-settings.json` in the current checkout. You can use any branching strategy your team prefers.

**Example setup:**

```
branch: main     → no environmentId          → draft mode (manual publish in UI)
branch: dev      → environmentId: EN-dev...  → auto-publishes to Development
branch: staging  → environmentId: EN-stg...  → auto-publishes to Staging
branch: prod     → environmentId: EN-prd...  → auto-publishes to Production
```

A property with 5 development environments would have 5 git branches, each with its corresponding `environmentId`. No central map required.

**`reactor-settings.json` is protected during merges.** The `.gitattributes` file marks it with `merge=ours`, so when you merge dev → staging, git automatically keeps staging's `reactor-settings.json` intact. You never need to manually revert it after a merge.

> **First-time branch setup**: when creating a new branch for an environment, edit `reactor-settings.json` to set the correct `environmentId` and commit it once. After that, merges will never overwrite it.

---

## Daily workflow

All commands run from the **repo root** inside `conda activate prisa`.

### Pull — download Launch → local files

```bash
node bin/index.js pull --settings-path ./properties/property1/reactor-settings.json
```

**Note:** Every time you run `pull`, the local property directory (e.g. `properties/property1/PRxxxx/`) is **deleted and recreated from scratch**. This ensures your local copy is a 1:1 reflection of Adobe Launch, automatically removing any local files for resources that were deleted in the platform.

Creates (or updates) `properties/property1/<propertyId>/` with:

```
<propertyId>/
  data_elements/
    DE0001abc/
      data.json              ← API snapshot, overwritten on every pull
      settings.json          ← static configuration (non-code attributes)
      settings.source.js     ← custom JS code (data elements only)
    _My Data Element Name -> DE0001abc   (symlink for readability)
  rules/
    RL0001abc/
      data.json
      settings.json
    _My Rule Name -> RL0001abc
  rule_components/
    RC0001abc/
      data.json
      settings.json
      settings.customCode.js ← custom JS code (rule actions/conditions)
    _My Rule Component Name -> RC0001abc
```

### Diff — preview what would change

```bash
node bin/index.js diff --settings-path ./properties/property1/reactor-settings.json
```

Output categories:


| Category      | Meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| **Modified**  | Local file is newer than Launch — your change would be pushed   |
| **Behind**    | Launch is newer than local — you need to pull first             |
| **Added**     | Exists locally but not in Launch (not yet synced automatically) |
| **Deleted**   | Exists in Launch but not locally                                |
| **Unchanged** | In sync                                                         |


### Sync — push local changes to Launch

```bash
node bin/index.js sync --settings-path ./properties/property1/reactor-settings.json
```

- **Draft mode**: pushes Modified items to Launch and pulls Behind items down. Publish manually in the UI afterwards.
- **Environment mode**: pushes Modified items to drafts, then automatically builds and publishes to the target environment.

---

## What to edit


| File                     | When to edit                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `settings.source.js`     | Custom JavaScript for **data elements** (Custom Code type). **This is the authoritative source for the code field.**                 |
| `settings.customCode.js` | Custom JavaScript for **rule components** (Custom Code actions/conditions). **This is the authoritative source for the code field.** |
| `settings.json`          | Non-code configuration fields only — see rule below                                                                                  |
| `data.json`              | **Never edit** — raw API snapshot, overwritten on every pull                                                                         |


### When both `settings.json` and a `.js` file exist

This happens with Custom Code data elements and rule components. The relationship is:

- `settings.source.js` (or `settings.customCode.js`) **always wins** over its corresponding field in `settings.json`. When `diff`/`sync` runs, it reads the `.js` file and injects its content into the settings object, overwriting whatever `settings.json` says for that field.
- As a result, **editing the code field inside `settings.json` has no effect** — it will be silently overwritten by the `.js` file.
- **Only edit `settings.json`** when it contains fields that have no corresponding `.js` file (e.g. a timeout, a flag, a non-code value specific to that extension).

**Rule of thumb:**

- Has a `settings.source.js` or `settings.customCode.js`? → edit the `**.js` file** for code changes, ignore the `source`/`customCode` field in `settings.json`.
- Only has `settings.json`? → edit `settings.json` directly for any change.

**Editing flow:**

1. Edit the right file (`.js` for code, `settings.json` for non-code fields without a `.js` counterpart)
2. Run `diff` to verify the change appears as **Modified**
3. Run `sync` to push to Launch (and auto-publish if in environment mode)

---

## Enabling extensions sync

Extensions are supported in the code but disabled in the download process by default. To enable, uncomment one line in `bin/pull.js`:

```js
const resourceTypes = [
  'data_elements',
  'rules',
  'rule_components',
  'extensions',   // ← uncomment this line to start syncing extensions
];
```

The `diff` and `sync` commands will automatically detect the presence of the `extensions/` folder and include them in the process.

---

## CI/CD — GitHub Actions auto-sync

The workflow at `.github/workflows/sync.yml` runs on every push to any branch, but **only when files under `properties/` change**. It uses a single job — no branch name detection.

### How it works

The workflow always calls `sync --ci` for `properties/property1/`. The sync command itself determines what to do by reading `reactor-settings.json` on the current branch and querying the Launch API for the environment type:

| `environmentId` present? | Environment type | What happens |
| ------------------------- | ---------------- | ------------ |
| No | — | Draft mode: pushes changes to drafts. No publish. |
| Yes | `development` | Pushes drafts + creates `git-sync-*` library + dev build. `--ci` aborts if any resource is Behind. |
| Yes | `staging` | Finds `git-sync-*` library in `development` state → submits → staging build. `--ci` flag ignored. |
| Yes | `production` | Finds `git-sync-*` library in `submitted` state → approves → final production build. `--ci` flag ignored. |

The `--ci` flag only has effect in dev/draft mode — it aborts with a failed job if any resource in Launch is more recent than local (Behind). In staging/prod mode the flag is silently ignored because those flows skip the diff entirely.

### Branch strategy and `reactor-settings.json` protection

Each git branch carries its own `reactor-settings.json` with the `environmentId` of the Launch environment it targets. The file is protected from being overwritten during merges via `.gitattributes` (`merge=ours`), so merging dev → staging never overwrites staging's settings with dev's.

Typical setup:

```
branch: main     → no environmentId          → draft mode (manual publish in UI)
branch: dev      → environmentId: EN-dev...  → auto-publishes to Development
branch: staging  → environmentId: EN-stg...  → auto-publishes to Staging
branch: prod     → environmentId: EN-prd...  → auto-publishes to Production
```

Branch names are completely free — the workflow does not read `github.ref_name`. What matters is the `environmentId` in `reactor-settings.json` on whichever branch was pushed.

> **Important**: after cloning or creating a new branch, set the correct `environmentId` in `reactor-settings.json` for that branch and commit it. This is a one-time step per branch.

### Full promotion workflow across branches

```
── push to dev branch ──────────────────────────────────────
  CI detects changes in properties/
  → sync --ci: push drafts + create git-sync-* library + dev build
  → library stays in "development" state

── merge dev → staging ─────────────────────────────────────
  reactor-settings.json keeps staging's environmentId (protected by .gitattributes)
  CI detects changes in properties/ (the merged files)
  → sync: finds git-sync-* library in "development" state
  → submits → staging build
  → library is now in "submitted" state (do QA in staging)

── merge staging → prod ────────────────────────────────────
  reactor-settings.json keeps prod's environmentId (protected by .gitattributes)
  CI detects changes in properties/ (the merged files)
  → sync: finds git-sync-* library in "submitted" state
  → approves → final production build → published
```

> **Gate rule**: if the expected library is not found, the job prints a warning and exits cleanly. You cannot promote to staging without a prior dev publish, and you cannot promote to production without a prior staging publish.
> **Blocking rule**: if a `git-sync-*` library is already in `submitted` state when staging runs, it warns and asks you to run the prod branch first.
> **Staging verification**: prod sync checks that the `submitted` library actually went through a staging build. A library manually submitted from the Launch UI without going through staging will be warned and skipped.

### Required GitHub Secrets

Set these in **GitHub repo Settings > Secrets and variables > Actions**:


| Secret                | Value                                         |
| --------------------- | --------------------------------------------- |
| `ADOBE_CLIENT_ID`     | Client ID from Adobe Developer Console        |
| `ADOBE_CLIENT_SECRET` | Client Secret from Adobe Developer Console    |
| `ADOBE_ORG_ID`        | Organization ID (format: `XXXXXXXX@AdobeOrg`) |


The `scopes` value is read from the committed `integration.config.json` — no secret needed for it.
The `propertyId` and `environmentId` for each property are read from the committed `reactor-settings.json` — no secrets needed for them either.

### What the `--ci` flag does

Used only on dev/main branches. When called with `--ci`, `sync` will:

- Exit 0 and do nothing if there are no Modified items
- Exit 0 after syncing if only Modified items exist and none are Behind
- **Exit 1** if any resource is Behind (Launch was changed after your last pull)

