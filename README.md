# Adobe Launch Reactor Sync

Bidirectional synchronisation of Adobe Launch (Tags) rules, data elements, and rule components with a Git repository.

Fork of [adobe/reactor-sync](https://github.com/adobe/reactor-sync) with the following changes:

- **OAuth 2.0 authentication** — the original JWT flow reached end-of-life on March 1, 2026. `bin/utils/getAccessToken.js` has been patched to use the `client_credentials` grant.
- **Multi-property support** — each Launch property lives under `properties/<name>/` with its own settings file so you can operate on any property independently.
- **Filtered resource types** — only `data_elements`, `rules`, and `rule_components` are synced; extensions and environments are left untouched.

---

## Prerequisites

- Conda environment `prisa` with Node.js 22 (`conda activate prisa`)
- An Adobe Developer Console project with **OAuth Server-to-Server** credentials and the Experience Platform Launch API added

---

## One-time setup

### 1. Get credentials from Adobe Developer Console

1. Go to https://developer.adobe.com/console
2. Open your project (or create one and add the Experience Platform Launch API)
3. Select **OAuth Server-to-Server** as the credential type
4. Assign product profiles that have Tags/Launch access
5. Copy **Client ID**, **Client Secret**, and **Organization ID** from the credential overview

### 2. Create `integration.json` (never commit this file)

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

### 3. Create the per-property settings file (never commit this file)

For each property you want to work with:

```bash
cp properties/web-prod/reactor-settings.example.json properties/web-prod/.reactor-settings.json
```

The example file already contains the correct `propertyId` for that property. The `.reactor-settings.json` is gitignored.

---

## Daily workflow

All commands run from the **repo root** inside `conda activate prisa`.

### Pull — download Launch → local files

```bash
node bin/index.js pull --settings-path ./properties/web-prod/.reactor-settings.json
```

Creates (or updates) `properties/web-prod/<propertyId>/` with:

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
node bin/index.js diff --settings-path ./properties/web-prod/.reactor-settings.json
```

Output categories:

| Category | Meaning |
|----------|---------|
| **Modified** | Local file is newer than Launch — your change would be pushed |
| **Behind** | Launch is newer than local — you need to pull first |
| **Added** | Exists locally but not in Launch (not yet synced automatically) |
| **Deleted** | Exists in Launch but not locally |
| **Unchanged** | In sync |

### Sync — push local changes to Launch

```bash
node bin/index.js sync --settings-path ./properties/web-prod/.reactor-settings.json
```

Pushes **Modified** items to Launch and pulls **Behind** items back down.

After sync, **publishing to an environment is a manual step** in the Launch UI:
> Publishing > Add All Changed Resources > Save and Build for Development

---

## What to edit

| File | When to edit |
|------|-------------|
| `settings.source.js` | Custom JavaScript for **data elements** (e.g. a Custom Code data element) |
| `settings.customCode.js` | Custom JavaScript for **rule components** (e.g. a Custom Code action) |
| `settings.json` | Non-code configuration (extension-specific settings, flags, field values) |
| `data.json` | **Never edit** — this is the raw API snapshot and is overwritten on every pull |

**Editing flow:**
1. Edit `settings.source.js` or `settings.customCode.js` (or `settings.json` for config changes)
2. Run `diff` to verify the change is detected as **Modified**
3. Run `sync` to push to Launch
4. Publish in the Launch UI

---

## Working with multiple properties

### Use an existing property

```bash
cp properties/web-prod/reactor-settings.example.json properties/<name>/.reactor-settings.json
# the example already has the correct propertyId — no edits needed
node bin/index.js pull --settings-path ./properties/<name>/.reactor-settings.json
```

### Add a new property

```bash
mkdir properties/<new-name>
```

Create `properties/<new-name>/reactor-settings.example.json`:

```json
{
  "propertyId": "PRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "environment": {
    "reactorUrl": "https://reactor.adobe.io"
  }
}
```

Then copy to `.reactor-settings.json` and pull:

```bash
cp properties/<new-name>/reactor-settings.example.json properties/<new-name>/.reactor-settings.json
node bin/index.js pull --settings-path ./properties/<new-name>/.reactor-settings.json
```

Commit the `reactor-settings.example.json` (with the real `propertyId`) — it is not sensitive.

---

## CI/CD — GitHub Actions auto-sync

The workflow at `.github/workflows/sync.yml` triggers on every push to `main` that touches `properties/**`. It automatically:

1. Detects which `properties/<name>/` folders changed
2. Runs `sync --ci` for each changed property
3. **Aborts with a failed job** if any resource in Launch is more recent than local (i.e. someone changed Launch directly since your last pull) — you must pull, review, commit, and push again

### Required GitHub Secrets

Set these in **GitHub repo Settings > Secrets and variables > Actions**:

| Secret | Value |
|--------|-------|
| `ADOBE_CLIENT_ID` | Client ID from Adobe Developer Console |
| `ADOBE_CLIENT_SECRET` | Client Secret from Adobe Developer Console |
| `ADOBE_ORG_ID` | Organization ID (format: `XXXXXXXX@AdobeOrg`) |

The `scopes` value is read from the committed `integration.config.json` — no secret needed for it.
The `propertyId` for each property is read from the committed `reactor-settings.example.json` — no secret needed for it either.

### What the `--ci` flag does

When called with `--ci`, `sync` will:
- Exit 0 and do nothing if there are no Modified items
- Exit 0 after syncing if only Modified items exist and none are Behind
- **Exit 1** if any resource is Behind (Launch was changed after your last pull)

---

## Launch environments

`reactor-sync` manages the **draft/working copy** of resources — it does not interact with Launch's Development, Staging, or Production environments directly. After a sync, your changes exist as drafts in Launch but are not yet deployed to any environment.

Publishing to environments is a **manual step** in the Launch UI.

**If you want full environment separation** (separate CI/CD pipelines for dev/staging/prod), the multi-property structure supports it: create three property folders pointing to three separate Launch properties, add each `reactor-settings.example.json` with its corresponding `propertyId`, and the CI/CD workflow handles each independently based on which folder changed.
