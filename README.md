# OIC One-Click Debug Controls

A local, Manifest V3 browser extension that adds guarded shortcuts to **Oracle Integration Cloud (OIC)** Design pages. It helps developers open an integration for editing, save it, activate Debug tracing, and navigate to its Run page without manually repeating the usual OIC navigation.

The extension runs entirely in your browser, uses your existing signed-in OIC session, and never stores Oracle credentials.

> Use it first in a non-critical development integration. This project automates visible OIC UI controls, which can change between Oracle releases or tenants.

## What it adds

| OIC page | Extension control | Result |
| --- | --- | --- |
| **Integrations** | **Apply Debug Settings to N Active** | Reconfigures every currently Active integration in scope, including integrations already in Debug, and applies the saved rerun and payload-validation settings. Active filters limit the scope; with no filters, all results are used. |
| **Instances** | **Edit** | Opens the exact integration and version in a Design tab. If Active, it safely deactivates it first. |
| **Integration editor** | **Save, Activate Debug & Run** | Saves pending edits, releases OIC's edit lock, activates the same integration with the selected tracing settings, then opens its Run page. |
| **Run** | **Edit** | Opens the current integration/version for editing, using the same guarded deactivate flow. |

## Safety behavior

- Every Edit action asks for confirmation, since deactivation may interrupt message processing and discard pending unprocessed requests.
- Debug activation warns before an unlock. The extension proceeds only when OIC's confirmation identifies the same integration and version.
- If an operation times out, authentication is required, or OIC's UI does not match the expected state, automation stops. A helper tab remains available for manual recovery.
- The source Instances page refreshes only after OIC reports a successful operation.
- OIC resets Debug tracing to Production after 24 hours.

## Install

### Load unpacked (recommended for development)

1. Clone or download this repository.
2. In Brave, open `brave://extensions`; in Chrome, open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked**.
5. Select the [`oic-debug-controls`](./oic-debug-controls) directory (the folder containing `manifest.json`).

### Load the packaged archive

The repository also includes `oic-debug-controls.zip`. Extract it first, then use **Load unpacked** and select the extracted `oic-debug-controls` directory. Chromium browsers do not load a `.zip` directly from the extensions page.

## Configure OIC environments

1. Click the extension icon and select the settings page.
2. Under **OIC environments**, add each OIC Design URL you use—for example, Dev or SIT.
3. Click **Save settings** and approve the browser's host-permission prompt.

Only HTTPS `*.oraclecloud.com` Design origins are accepted. The default Hyderabad Design origin is already configured. New environments take effect in currently open OIC tabs as well as future ones.

Debug tracing is always used. You can configure the runtime options applied during bulk activation:

- **Allow to run again**
- **Enable payload validation**

## Typical workflow

### Bulk Debug activation

1. Open OIC **Integrations**.
2. Apply filters when you want to limit the scope. With no filters, the action covers the full result set.
3. Select **Apply Debug Settings to _N_ Active** and review the exact confirmation list.
4. The extension processes integrations sequentially, re-checks that each one is still Active, selects Debug, applies the saved runtime options, and saves. Locked, inactive, or concurrently busy integrations are skipped.

The bulk action applies the saved **Allow to run again** and **Enable payload validation** values, including to integrations already showing DEBUG TRACING.

### Edit, activate, and run

1. Open OIC **Instances** and locate an integration in the **Primary identifier** column.
2. Select **Edit** beside it and confirm the prompt.
3. Make your changes in OIC's integration editor.
4. Select **Save, Activate Debug & Run**.
5. Confirm the action; the extension saves, exits the editor to release the OIC lock, activates Debug tracing, and opens the Run page for that same integration/version.

For an active integration, Edit opens a new Design tab and waits for the deactivation to complete before opening the editor. It targets the integration/version rather than a particular runtime instance.

## Development

No third-party dependencies are required. From the extension directory:

```bash
cd oic-debug-controls
npm test
npm run check
```

- `npm test` checks integration target parsing.
- `npm run check` validates JavaScript syntax across the extension scripts.

After source changes, return to the browser's extensions page and choose **Reload** for the extension.

## Project layout

```text
oic-debug-controls/
├── background/service-worker.js  # OIC operation orchestration
├── content/                      # Controls injected into OIC pages
├── options/                      # Environment and activation settings
├── shared/targets.js             # Integration/version parsing helpers
├── tests/targets.test.js         # Parser tests
└── manifest.json                 # Manifest V3 extension definition
```

## Limitations

- This is a locally loaded extension, not a Chrome Web Store package.
- It relies on OIC's accessible labels and current page structure; Oracle UI changes can require updates.
- It does not bypass OIC permissions, confirmation dialogs, authentication, or integration locking rules.

## License

No license has been specified for this repository. Add one before redistributing or accepting outside contributions.
