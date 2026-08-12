# OIC One-Click Debug Controls

Local Manifest V3 extension for the Dev OIC design host. It adds one **Edit** control beside integration links only on OIC Instances, **Save, Activate Debug & Run** in the integration editor, and **Edit** on the Run page. The extension uses the already signed-in browser session and a helper tab; it does not store Oracle credentials.

Open the extension's settings to add one or more OIC Design environments (for example Dev and SIT). Enter the Design URL for each Oracle Cloud environment, save, and approve the browser permission prompt. Controls are applied to open OIC tabs immediately.

The Run-page **Edit** control is isolated from OIC's native **Run** action, so selecting Edit never submits a run. Its arrow icon and tooltip indicate that the editor opens in a new browser tab.

## Install in Brave

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this `oic-debug-controls` folder.
5. Open the OIC **Instances** view. **Edit** appears immediately beside each integration link in the **Primary identifier** column.

Selecting **Edit** immediately switches to a new Design tab and finds the exact integration/version there. If it is Active, the extension deactivates it, waits for Configured status, and then opens that integration in the designer. If it is already Configured, it opens the designer directly.

From the integration editor, **Save, Activate Debug & Run** saves pending changes (if any), leaves the editor to release OIC's edit lock, and activates the exact integration with the saved Debug activation settings. If OIC still reports that exact target as Locked, the confirmed flow unlocks it, reloads and verifies that the Locked state cleared, and only then activates. It turns the same tab into the OIC Run page. From the Run page, **Edit** uses the same guarded deactivate-then-open-editor flow as Instances.

## Safety and behavior

- Edit always asks for confirmation because its automatic deactivation step can discard pending work. The helper requires Oracle's confirmation to contain the exact integration name and version; a mismatch is cancelled without submission.
- Debug activation warns before an Unlock because Oracle says unlocking can cause data loss. The extension unlocks only after the user confirms and only when Oracle's dialog identifies the exact integration/version.
- Locked-row automation supports OIC's current icon-only overflow menu: it opens that exact row's menu, chooses Unlock, reloads to verify the unlock, then activates.
- Buttons are attached only to integration links in Primary identifier. They operate on the integration/version, not on the individual runtime instance.
- The current Instances tab is refreshed only after OIC reports success.
- If OIC's UI changes, a timeout occurs, or authentication is needed, the operation stops without blind retries and offers the helper tab for manual recovery.
- The helper automation intentionally uses visible OIC labels, not hard-coded screen coordinates. OIC custom components can vary by tenant/release, so validate activation and deactivation in a non-critical Dev integration first.
- Debug tracing is reset by Oracle to Production after 24 hours.

## Development

Run `npm test` and `npm run check` from this folder. No dependencies are required.
