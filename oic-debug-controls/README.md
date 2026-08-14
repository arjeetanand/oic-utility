# OIC One-Click Debug Controls

A local Manifest V3 extension for **Oracle Integration Cloud (OIC)**. It adds guarded controls to OIC Design pages so you can open an integration for editing, activate Debug tracing, and navigate to its Run page with fewer manual steps.

It uses the browser's existing signed-in OIC session and does not store Oracle credentials.

> Validate the extension in a non-critical Dev integration first. It automates OIC's visible UI, which may differ between Oracle releases and tenants.

## Controls

| OIC page | Added control | What it does |
| --- | --- | --- |
| **Integrations** | **Apply Debug Settings to N Active** | Applies Debug tracing and the saved rerun and payload-validation settings to every currently Active integration in the current filtered results, or all results when no filter is applied. |
| **Instances** | **Edit** | Opens the selected integration/version in a new Design tab. If it is Active, it deactivates it before opening the editor. |
| **Integration editor** | **Save, Activate Debug & Run** | Saves pending work, releases the editor lock, activates the exact integration with Debug settings, and opens its Run page. |
| **Run page** | **Edit** | Opens the current integration/version in the editor using the same guarded deactivate flow. |

## Install

1. In Brave, open `brave://extensions`; in Chrome, open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `oic-debug-controls` folder—the one containing `manifest.json`.

To use the repository's ZIP package, extract `oic-debug-controls.zip` first, then select its extracted `oic-debug-controls` directory. Chromium browsers cannot load an extension directly from a ZIP file.

## Configure environments

1. Click the extension icon to open **OIC Debug Controls** settings.
2. Under **OIC environments**, add every OIC Design URL you use, such as Dev and SIT.
3. Click **Save settings** and approve the browser permission prompt.

Only HTTPS `*.oraclecloud.com` URLs are accepted. The extension requests access only for saved origins; controls are injected into already open matching OIC tabs immediately.

Debug tracing is always used. Settings let you choose whether to allow reruns or enable payload validation during activation.

## Workflow

### Bulk Debug activation

1. Open **Integrations** and optionally apply filters.
2. Select **Apply Debug Settings to _N_ Active**.
3. Review and confirm the exact scope. The extension processes each integration sequentially and reports updated, skipped, and failed counts.

The bulk action re-checks status immediately before each change and skips integrations that are no longer Active. It reapplies Debug and the saved **Allow to run again** and **Enable payload validation** selections, including for integrations already in Debug.

### Edit, activate, and run

1. In OIC **Instances**, select **Edit** beside an integration link in the **Primary identifier** column.
2. Confirm the prompt. If the integration is Active, the extension waits for OIC to deactivate it and then opens the editor.
3. Make your changes and select **Save, Activate Debug & Run**.
4. Confirm the action. The extension saves the integration, exits the editor to release OIC's lock, activates Debug tracing, and opens the exact integration/version's Run page.

From a Run page, select **Edit** to return to the editor. Its arrow icon and tooltip indicate that the editor opens in a new browser tab.

## Safety and recovery

- Edit always requires confirmation because deactivation can interrupt new messages and pending unprocessed requests may be lost.
- If OIC reports an integration as Locked, Debug activation requests confirmation before unlocking; Oracle warns that unlocking can cause data loss.
- Confirmation dialogs must identify the exact integration name and version. Any mismatch cancels the operation without submitting it.
- Operations stop rather than retry blindly when OIC changes, a timeout occurs, or sign-in is required. The helper Design tab remains available for manual recovery.
- The Instances tab refreshes only after OIC reports success.
- Oracle resets Debug tracing to Production after 24 hours.

The extension targets an integration/version, not an individual runtime instance, and does not bypass any OIC permission, authentication, confirmation, or locking rule.

## Development

No third-party dependencies are required.

```bash
npm test
npm run check
```

`npm test` checks integration/version parsing. `npm run check` validates JavaScript syntax in the extension scripts.

After changing source files, select **Reload** on the browser's extensions page before retesting.

## Structure

```text
background/service-worker.js  # Orchestrates OIC actions and helper tabs
content/                      # Controls injected into OIC pages
options/                      # Environment and debug activation settings
shared/targets.js             # Integration/version parsing helpers
tests/targets.test.js         # Parser tests
manifest.json                 # Manifest V3 configuration
```
