/* global importScripts, chrome, OicTargets */
importScripts("../shared/targets.js");

var DEFAULT_ORIGIN = "https://design.integration.ap-hyderabad-1.ocp.oraclecloud.com";
var CONTENT_SCRIPT_ID = "oic-debug-controls-configured-hosts";
var DEFAULTS = { tracingLevel: "debug", allowRunAgain: true, payloadValidation: false, environments: [DEFAULT_ORIGIN] };
var activeOperations = new Map();

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get(DEFAULTS, function (stored) { chrome.storage.local.set(stored, syncConfiguredContentScripts); });
});
chrome.runtime.onStartup.addListener(function () { syncConfiguredContentScripts(); });

chrome.action.onClicked.addListener(function () { chrome.runtime.openOptionsPage(); });

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === "oic:get-state") {
    sendResponse({ state: activeOperations.get(message.target.key) || null });
    return;
  }
  if (message.type === "oic:start") {
    startOperation(message.operation, message.target, sender.tab && sender.tab.id)
      .then(function (result) { sendResponse({ ok: true, result: result }); })
      .catch(function (error) { sendResponse({ ok: false, error: serializeError(error) }); });
    return true;
  }
  if (message.type === "oic:start-bulk") {
    // A tab that was open while the extension updated can still have the previous
    // content script. Fail immediately instead of re-entering the obsolete single
    // long-running bulk event; refreshing the OIC tab loads the bounded v0.6.6 flow.
    sendResponse({ ok: false, error: { message: "Refresh this OIC Integrations tab, then run Apply Debug Settings again." } });
    return;
  }
  if (message.type === "oic:start-bulk-target") {
    startBulkTarget(message.target, sender.tab && sender.tab.id, message.runtimeOptions)
      .then(function (result) { sendResponse({ ok: true, result: result }); })
      .catch(function (error) { sendResponse({ ok: false, error: serializeError(error) }); });
    return true;
  }
  if (message.type === "oic:get-runtime-options") {
    storageGet(DEFAULTS).then(function (settings) {
      sendResponse({ ok: true, runtimeOptions: { allowRunAgain: !!settings.allowRunAgain, payloadValidation: !!settings.payloadValidation } });
    }).catch(function (error) { sendResponse({ ok: false, error: serializeError(error) }); });
    return true;
  }
  if (message.type === "oic:open-helper") {
    if (Number.isInteger(message.tabId)) chrome.tabs.update(message.tabId, { active: true });
  }
  if (message.type === "oic:sync-hosts") {
    syncConfiguredContentScripts().then(function () { sendResponse({ ok: true }); }).catch(function (error) { sendResponse({ ok: false, error: error.message || String(error) }); });
    return true;
  }
});

function originPattern(url) { return new URL(url).origin + "/*"; }

function configuredOrigins() {
  return storageGet(DEFAULTS).then(function (settings) {
    return Array.from(new Set((settings.environments || [DEFAULT_ORIGIN]).map(function (value) {
      try { var url = new URL(value); return url.protocol === "https:" ? url.origin : null; } catch (_error) { return null; }
    }).filter(Boolean)));
  });
}

async function syncConfiguredContentScripts() {
  var origins = await configuredOrigins();
  // The default Hyderabad environment is injected statically by manifest.json so
  // the control works even before this service worker wakes. Register only extra
  // user-configured environments dynamically.
  var matches = origins.filter(function (origin) { return origin !== DEFAULT_ORIGIN; }).map(function (origin) { return origin + "/*"; });
  try { await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }); } catch (_error) {}
  if (matches.length) await chrome.scripting.registerContentScripts([{ id: CONTENT_SCRIPT_ID, matches: matches, js: ["shared/targets.js", "content/content.js"], css: ["content/content.css"], runAt: "document_idle" }]);
  // Registered content scripts run on the next navigation. Inject once into any
  // matching tabs already open, so adding Dev/SIT takes effect immediately.
  var tabs = matches.length ? await new Promise(function (resolve) { chrome.tabs.query({ url: matches }, resolve); }) : [];
  await Promise.all(tabs.map(async function (tab) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared/targets.js", "content/content.js"], world: "ISOLATED" });
    } catch (_error) {
      // Ignore a tab that is navigating or has already closed; the registered
      // content script will load on its next completed navigation.
    }
  }));
}

function serializeError(error) {
  return { message: error && error.message ? error.message : String(error), helperTabId: error && error.helperTabId };
}

// Run one bulk target per runtime message. A full batch can legitimately take more
// than Chrome's service-worker event lifetime because OIC may spend up to 90 seconds
// verifying each integration. Keeping every row inside one message caused larger
// batches to be terminated mid-run with no final result. The content script now
// sequences these bounded target operations and owns the aggregate summary.
async function startBulkTarget(target, sourceTabId, requestedRuntimeOptions) {
  if (!Number.isInteger(sourceTabId)) throw new Error("This action must be started from an OIC Integrations tab.");
  var source = await chrome.tabs.get(sourceTabId);
  if (!source || !/[?&]root=integrations(?:&|$)/i.test(source.url || "")) throw new Error("Activate Active in Debug must be started from the OIC Integrations list.");
  validateRequest("activate-debug", target, sourceTabId);
  if (activeOperations.has(target.key)) return { status: "skipped-busy", target: target };

  var stored = await storageGet(DEFAULTS);
  var runtimeOptions = requestedRuntimeOptions && typeof requestedRuntimeOptions === "object" ? requestedRuntimeOptions : stored;
  var prefs = Object.assign({}, stored, {
    allowRunAgain: !!runtimeOptions.allowRunAgain,
    payloadValidation: !!runtimeOptions.payloadValidation,
    tracingLevel: "debug",
    preserveActivationOptions: false,
    requireActive: true
  });
  var operationState = { phase: "Applying Debug settings to " + target.name, operation: "activate-debug", target: target, sourceTabId: sourceTabId, helperTabId: null };
  activeOperations.set(target.key, operationState);
  publishState(target.key, sourceTabId);
  try {
    return await runUiProvider("activate-debug", target, prefs, operationState);
  } finally {
    activeOperations.delete(target.key);
    publishState(target.key, sourceTabId);
  }
}

async function startOperation(operation, target, sourceTabId) {
  validateRequest(operation, target, sourceTabId);
  if (activeOperations.has(target.key)) throw new Error("An operation is already running for " + target.key + ".");
  var prefs = await storageGet(DEFAULTS);
  var state = { phase: "Opening OIC Design…", operation: operation, target: target, sourceTabId: sourceTabId, helperTabId: null };
  activeOperations.set(target.key, state);
  publishState(target.key);
  try {
    if (operation === "activate-debug-run") {
      state.phase = "Saving changes…";
      publishState(target.key);
      var saved = await saveEditorIfNeeded(sourceTabId, target);
      if (!saved || !saved.ok) throw new Error((saved && saved.error) || "OIC did not save the integration before activation.");
      state.phase = "Releasing the editor lock…";
      publishState(target.key);
      var released = await leaveEditorForActivation(sourceTabId);
      if (!released.ok) throw new Error(released.error || "Could not leave the editor to release OIC's edit lock.");
    }
    var result = await runUiProvider(operation, target, prefs, state);
    if (!result.skipSourceRefresh) {
      state.phase = "Refreshing Instances…";
      publishState(target.key);
      await refreshSource(sourceTabId);
    }
    state.phase = "Complete";
    state.complete = true;
    publishState(target.key);
    setTimeout(function () { activeOperations.delete(target.key); publishState(target.key, sourceTabId); }, 3000);
    return result;
  } catch (error) {
    state.error = error.message || String(error);
    state.helperTabId = error.helperTabId || state.helperTabId;
    publishState(target.key);
    // An explicit new user click may retry after a safe, pre-submission failure. Keep the
    // helper tab available for review, but never leave a stale in-progress lock behind.
    activeOperations.delete(target.key);
    publishState(target.key, sourceTabId);
    throw error;
  }
}

function validateRequest(operation, target, sourceTabId) {
  if (operation !== "activate-debug" && operation !== "deactivate" && operation !== "edit" && operation !== "activate-debug-run") throw new Error("Unsupported operation.");
  if (!target || !String(target.name || "").trim() || !/^\d+(?:\.\d+){1,3}$/.test(target.version || "")) {
    throw new Error("The integration name/version could not be identified from this OIC page.");
  }
  if (!Number.isInteger(sourceTabId)) throw new Error("This action must be started from an OIC tab.");
}

function publishState(key, sourceTabId) {
  var operation = activeOperations.get(key);
  var tabId = operation && operation.sourceTabId || sourceTabId;
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.get(tabId, function (source) {
    if (chrome.runtime.lastError || !source || !source.url) return;
    chrome.tabs.query({ url: originPattern(source.url) }, function (tabs) {
      tabs.forEach(function (tab) { chrome.tabs.sendMessage(tab.id, { type: "oic:state", key: key, state: activeOperations.get(key) || null }).catch(function () {}); });
    });
  });
}

function storageGet(defaults) {
  return new Promise(function (resolve) { chrome.storage.local.get(defaults, resolve); });
}

function waitForTab(tabId, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(cleanup, timeoutMs, false);
    function onUpdated(id, change, tab) {
      if (id === tabId && change.status === "complete") cleanup(true, tab);
    }
    function cleanup(ok, tab) { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); ok ? resolve(tab) : reject(new Error("OIC Design did not load within " + (timeoutMs / 1000) + " seconds.")); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, function (tab) { if (!chrome.runtime.lastError && tab.status === "complete") cleanup(true, tab); });
  });
}

async function execute(tabId, func, args) {
  var results = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: func, args: args, world: "ISOLATED" });
  return results[0] && results[0].result;
}

async function runUiProvider(operation, target, prefs, state) {
  var source = await chrome.tabs.get(state.sourceTabId);
  var instance = new URL(source.url).searchParams.get("integrationInstance");
  if (!instance) throw new Error("Could not determine the OIC service instance from this page.");
  // Start on the Integrations list directly. Cloning the Instances URL and clicking the
  // Design navigation is unreliable when OIC's left navigation is collapsed.
  var hostTabs = await new Promise(function (resolve) { chrome.tabs.query({ url: originPattern(source.url) }, resolve); });
  var existingList = hostTabs.find(function (tab) { return /[?&]root=integrations(?:&|$)/i.test(tab.url || ""); });
  var helperUrl;
  if (existingList) {
    helperUrl = new URL(existingList.url);
    helperUrl.searchParams.set("integrationInstance", instance);
  } else {
    helperUrl = new URL(source.url);
    helperUrl.searchParams.set("root", "integrations");
    helperUrl.searchParams.delete("oj_Router");
    helperUrl.searchParams.set("integrationInstance", instance);
    helperUrl.hash = "";
  }
  // Reuse the source tab after it leaves the editor. The editor owns OIC's lock, so
  // activating through a second tab would still see the exact integration as Locked.
  // Every Edit request starts from a separate Design tab. Keeping an opener link makes
  // the relationship clear in the browser while preserving the original OIC page.
  var helper = operation === "activate-debug-run" && /[?&]root=integrations(?:&|$)/i.test(source.url || "")
    ? source
    // Edit is a user-requested navigation: foreground the new Design tab right away
    // so the user does not have to locate and select it while OIC is loading.
    : await chrome.tabs.create({ url: helperUrl.toString(), active: operation === "edit", openerTabId: source.id });
  state.helperTabId = helper.id;
  // Bulk Debug always uses a disposable helper tab. Close it in finally, even
  // when OIC rejects a change, so only the original Integrations tab remains.
  var closeHelperWhenFinished = operation === "activate-debug" && helper.id !== source.id;
  try {
    if (helper.id !== source.id) await waitForTab(helper.id, 30000);
    state.phase = operation === "activate-debug" || operation === "activate-debug-run" ? "Opening Integrations and activating debug…" : operation === "edit" ? "Checking integration status…" : "Opening Integrations and deactivating…";
    publishState(target.key);
    var submitted = await execute(helper.id, executeUiFlow, [operation, target, prefs]);
    if (!submitted || !submitted.ok) throw withHelper(new Error((submitted && submitted.error) || "OIC did not accept the operation."), helper.id);
    var verified = { ok: true, status: submitted.status || "configured" };
    if (submitted.submitted) {
    state.phase = "Waiting for OIC to finish…";
    publishState(target.key);
    verified = await verifyWithReloads(helper.id, operation === "edit" ? "deactivate" : operation === "activate-debug-run" ? "activate-debug" : operation, target, 90000);
    if (!verified.ok) throw withHelper(new Error(verified.error || "OIC did not reach the expected status. Review the helper tab."), helper.id);
    }
    if (operation === "activate-debug" || operation === "activate-debug-run") {
    state.phase = "Verifying Debug runtime options…";
    publishState(target.key);
    var runtimeVerified = await verifyActivationRuntimeOptions(helper.id, target, prefs);
    if (!runtimeVerified || !runtimeVerified.ok) {
      // Configure activation is saved exactly once. If OIC acknowledges the
      // save but does not persist a checkbox, report the observed mismatch;
      // do not silently perform a second activation/save.
      throw withHelper(new Error((runtimeVerified && runtimeVerified.error) || "OIC did not persist the required Debug runtime options."), helper.id);
    }
    }
    if (operation === "edit") {
    state.phase = "Opening integration editor…";
    publishState(target.key);
    var opened = await execute(helper.id, openTargetEditor, [target]);
    if (!opened || !opened.ok) throw withHelper(new Error((opened && opened.error) || "The integration editor did not open."), helper.id);
    var editor = await waitForEditor(helper.id, target, 25000);
    if (!editor.ok) throw withHelper(new Error(editor.error || "The integration editor did not become editable."), helper.id);
    await chrome.tabs.update(helper.id, { active: true });
    return { status: "editor-open", target: target, helperTabId: helper.id };
    }
    if (operation === "activate-debug-run") {
    state.phase = "Opening Run…";
    publishState(target.key);
    // Oracle exposes Run from the exact integration row's Actions menu. Opening
    // the integration name after activation only loads the read-only canvas and
    // does not expose Run, so stay on the verified Integrations list.
    var runOpened = await openRunFromIntegrationsList(helper.id, target);
    if (!runOpened.ok) throw withHelper(new Error(runOpened.error || "OIC activated the integration but could not open its Run page."), helper.id);
    return { status: "run-open", target: target, skipSourceRefresh: true };
    }
    return { status: verified.status, target: target, verification: runtimeVerified && runtimeVerified.options };
  } catch (error) {
    // This tab is intentionally closed below, so never offer a dead helper-tab
    // link in the bulk error toast.
    if (closeHelperWhenFinished && error) error.helperTabId = null;
    throw error;
  } finally {
    if (closeHelperWhenFinished) await closeHelperTab(helper.id);
  }
}

async function verifyActivationRuntimeOptions(tabId, target, prefs) {
  var last;
  // OIC can update its list badge before the activation-sheet model settles.
  // Re-open and read the exact settings up to three times, without another Save.
  for (var attempt = 0; attempt < 3; attempt += 1) {
    last = await execute(tabId, inspectActivationRuntimeOptions, [target, prefs]);
    if (last && last.ok) return last;
    if (attempt < 2) await new Promise(function (resolve) { setTimeout(resolve, 1800); });
  }
  return last || { ok: false, error: "OIC did not expose runtime options for verification." };
}

async function closeHelperTab(tabId) {
  try { await chrome.tabs.remove(tabId); }
  catch (_error) {
    // It may already be closed by the user or by OIC navigation. Either way the
    // bulk operation must continue and leave the original source tab in place.
  }
}

function withHelper(error, tabId) { error.helperTabId = tabId; return error; }

async function verifyWithReloads(tabId, operation, target, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 2500); });
    await new Promise(function (resolve) { chrome.tabs.reload(tabId, {}, resolve); });
    await waitForTab(tabId, 30000);
    var result = await execute(tabId, inspectTargetStatus, [operation, target]);
    if (result && (result.ok || result.terminalError)) return result;
  }
  return { ok: false, error: "Timed out waiting for OIC to update " + target.code + "|" + target.version + "." };
}

async function saveEditorIfNeeded(tabId, target) {
  try { return await execute(tabId, saveCurrentEditor, [target]); }
  catch (error) { return { ok: false, error: error.message || String(error) }; }
}

async function leaveEditorForActivation(tabId) {
  try {
    // Do not rewrite the route here. OIC's editor owns a server-side edit lock and
    // only its native Go back command releases it. URL navigation appears to leave
    // the editor but creates the exact Locked state that blocked debug activation.
    var exited = await execute(tabId, leaveCurrentEditor, []);
    if (!exited || !exited.ok) return exited || { ok: false, error: "OIC's editor Go back command was unavailable; the lock was not released." };
    var deadline = Date.now() + 25000;
    var opened;
    while (Date.now() < deadline) {
      opened = await execute(tabId, inspectIntegrationsList, []);
      if (opened && opened.ok) break;
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
    }
    if (!opened || !opened.ok) return { ok: false, error: "OIC did not return to the Integrations list after releasing the editor lock." };
    await new Promise(function (resolve) { setTimeout(resolve, 1200); });
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}

function inspectIntegrationsList() {
  return { ok: /root=integrations(?:&|$)/i.test(location.href) };
}

function leaveCurrentEditor() {
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function visible(element) { return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length); }
  try {
    if (!/root=integration(?:&|$)/i.test(location.href) || /root=integrations(?:&|$)/i.test(location.href)) {
      return { ok: false, error: "The source tab is no longer an OIC editor." };
    }
    var back = Array.from(document.querySelectorAll("button,a,[role=button],oj-button")).find(function (element) {
      var label = clean([element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" "));
      return visible(element) && (label === "go back" || label === "back to integrations");
    });
    if (!back) return { ok: false, error: "OIC's editor Go back control was not found; activation was stopped to avoid a stale lock." };
    back.click();
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}

async function openRunFromIntegrationsList(tabId, target) {
  try {
    var opened = await execute(tabId, openTargetRunFromList, [target]);
    if (!opened || !opened.ok) return opened || { ok: false, error: "The exact integration Actions menu did not expose Run." };
    var deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      var tab = await chrome.tabs.get(tabId);
      if (/root=invokeIntegration(?:&|$)/i.test(tab.url || "")) return { ok: true };
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
    }
    return { ok: false, error: "Timed out waiting for OIC's Run page." };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}

async function openTargetRunFromList(target) {
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(element) { var style = getComputedStyle(element); return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length) && style.visibility !== "hidden" && style.display !== "none"; }
  function labelOf(element) { return clean([element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-oj-tooltip"), element.textContent].filter(Boolean).join(" ")); }
  function versionParts(value) {
    var parts = String(value || "").split(".").map(function (part) { return String(parseInt(part, 10) || 0); });
    while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
    return parts.join(".");
  }
  function findRow() {
    return Array.from(document.querySelectorAll('tr,[role="row"],oj-list-item,li')).find(function (candidate) {
      var text = clean(candidate.innerText || candidate.textContent);
      var hasVersion = text.split(/\s+/).some(function (word) { return versionParts(word.replace(/[^0-9.]/g, "")) === versionParts(target.version); });
      var exactNameLink = Array.from(candidate.querySelectorAll("a")).some(function (link) {
        return clean([link.getAttribute("aria-label"), link.getAttribute("title"), link.textContent].filter(Boolean).join(" ")) === target.name;
      });
      return visible(candidate) && exactNameLink && hasVersion && /\bactive\b/i.test(text);
    });
  }
  function pointerClick(element) {
    var box = element.getBoundingClientRect();
    var options = { bubbles: true, cancelable: true, view: window, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0, buttons: 1 };
    try { element.dispatchEvent(new PointerEvent("pointerdown", options)); } catch (_error) {}
    element.dispatchEvent(new MouseEvent("mousedown", options));
    try { element.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, options, { buttons: 0 }))); } catch (_error2) {}
    element.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, options, { buttons: 0 })));
    element.dispatchEvent(new MouseEvent("click", Object.assign({}, options, { buttons: 0 })));
  }
  try {
    if (!/root=integrations(?:&|$)/i.test(location.href)) throw new Error("OIC is not on the Integrations list after activation.");
    var deadline = Date.now() + 15000;
    var row;
    while (Date.now() < deadline && !(row = findRow())) await new Promise(function (resolve) { setTimeout(resolve, 350); });
    if (!row) throw new Error("Could not relocate the active " + target.name + " (" + target.version + ") row.");

    row.scrollIntoView({ block: "center" });
    row.click();
    ["mouseover", "mouseenter", "pointerover", "pointerenter"].forEach(function (type) {
      row.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
    });
    await new Promise(function (resolve) { setTimeout(resolve, 500); });

    var rowControls = Array.from(row.querySelectorAll('button,a,[role="button"],oj-button,[role="menuitem"]'));
    var directRun = rowControls.find(function (item) { return /^run$/i.test(labelOf(item)); });
    if (directRun) {
      pointerClick(directRun);
    } else {
      var actions = rowControls.find(function (item) {
        return /actions|action menu|more actions|show actions|more options/i.test(labelOf(item)) || /menu|true/i.test(String(item.getAttribute("aria-haspopup") || ""));
      });
      if (!actions) {
        var links = Array.from(row.querySelectorAll("a"));
        var detailsIndex = links.findIndex(function (item) { return /open details/i.test(labelOf(item)); });
        actions = detailsIndex > 0 ? links[detailsIndex - 1] : null;
      }
      if (!actions) throw new Error("The exact integration row has no Actions menu.");
      pointerClick(actions);
      var menuDeadline = Date.now() + 8000;
      var run;
      while (Date.now() < menuDeadline && !run) {
        run = Array.from(document.querySelectorAll('button,a,[role="button"],[role="menuitem"],oj-option')).find(function (item) {
          return visible(item) && /^run$/i.test(labelOf(item));
        });
        if (!run) await new Promise(function (resolve) { setTimeout(resolve, 250); });
      }
      if (!run) throw new Error("OIC did not expose Run in the exact integration Actions menu.");
      run.click();
    }
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}

async function saveCurrentEditor(target) {
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(element) { return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length); }
  function disabled(element) { return element.disabled === true || element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled"); }
  function named(name) { return Array.from(document.querySelectorAll("button,a,[role=button],oj-button")).find(function (element) { return visible(element) && clean([element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" ")).toLowerCase() === name; }); }
  try {
    if (!/root=integration(?:&|$)/i.test(location.href) || /root=integrations(?:&|$)/i.test(location.href)) throw new Error("Save, Activate Debug & Run must be started from the integration editor.");
    if (document.body.innerText.indexOf(target.name) === -1) throw new Error("The editor does not show " + target.name + ".");
    var save = named("save");
    if (!save || disabled(save)) return { ok: true, saved: false };
    save.click();
    var deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (disabled(save)) return { ok: true, saved: true };
      await new Promise(function (resolve) { setTimeout(resolve, 350); });
    }
    return { ok: false, error: "OIC did not finish saving within 25 seconds." };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}

async function inspectTargetStatus(operation, target) {
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(element) { return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length); }
  function versionParts(value) {
    var parts = String(value || "").split(".").map(function (part) { return String(parseInt(part, 10) || 0); });
    while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
    return parts.join(".");
  }
  function setSearch() {
    var search = Array.from(document.querySelectorAll("input")).find(function (input) { return visible(input) && /search|full or partial integration/i.test(clean([input.getAttribute("aria-label"), input.getAttribute("placeholder")].join(" "))); });
    if (!search) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, target.name);
    search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: target.name }));
    search.dispatchEvent(new Event("change", { bubbles: true }));
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  setSearch();
  var deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    var row = Array.from(document.querySelectorAll('tr,[role="row"],oj-list-item,li')).find(function (candidate) {
      var text = clean(candidate.innerText || candidate.textContent);
      return visible(candidate) && text.indexOf(target.name) !== -1 && text.split(/\s+/).some(function (word) { return versionParts(word.replace(/[^0-9.]/g, "")) === versionParts(target.version); });
    });
    if (row) {
      var status = clean(row.innerText || row.textContent).toLowerCase();
      if (/activation failed|failed to activate|deactivation failed/.test(status)) return { ok: false, terminalError: true, error: "OIC reported a failure for " + (target.code || target.name) + "." };
      if (operation === "activate-debug" && /\bactive\b/.test(status) && /debug tracing|debug/.test(status)) return { ok: true, status: "active-debug" };
      if (operation === "deactivate" && /\bconfigured\b|\binactive\b/.test(status)) return { ok: true, status: "configured" };
      return { ok: false, status: status };
    }
    await new Promise(function (resolve) { setTimeout(resolve, 400); });
  }
  return { ok: false, status: "target-not-visible" };
}

// The Integrations list exposes only the tracing badge. It cannot tell whether
// OIC persisted Enable payload validation, so inspect the exact Configure
// activation sheet after every bulk Debug operation before reporting success.
async function inspectActivationRuntimeOptions(target, prefs) {
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(element) {
    if (!element) return false;
    var style = getComputedStyle(element);
    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length) && style.visibility !== "hidden" && style.display !== "none";
  }
  function labelOf(element) { return clean([element.getAttribute("aria-label"), element.getAttribute("title"), element.value, element.textContent].filter(Boolean).join(" ")); }
  function versionParts(value) {
    var parts = String(value || "").split(".").map(function (part) { return String(parseInt(part, 10) || 0); });
    while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
    return parts.join(".");
  }
  function findRow() {
    var expectedVersion = versionParts(target.version);
    return Array.from(document.querySelectorAll("tr,[role=row],oj-list-item,li")).find(function (row) {
      var text = clean(row.innerText || row.textContent);
      var correctName = Array.from(row.querySelectorAll("a")).some(function (link) { return clean(labelOf(link)) === target.name; });
      var correctVersion = text.split(/\s+/).some(function (word) { return versionParts(word.replace(/[^0-9.]/g, "")) === expectedVersion; });
      return visible(row) && correctName && correctVersion && /\bactive\b/i.test(text);
    });
  }
  function findSheet() {
    var saves = Array.from(document.querySelectorAll("button")).filter(function (button) { return visible(button) && /^save$/i.test(labelOf(button)); });
    for (var index = 0; index < saves.length; index += 1) {
      var ancestor = saves[index].parentElement;
      while (ancestor && ancestor !== document.body) {
        var text = clean(ancestor.innerText || ancestor.textContent);
        if (text.indexOf(target.name) !== -1 && /select tracing level|configure activation/i.test(text)) return ancestor;
        ancestor = ancestor.parentElement;
      }
    }
    return null;
  }
  function findCheckbox(sheet, text) {
    var label = Array.from(sheet.querySelectorAll("label")).find(function (item) { return visible(item) && clean(item.textContent).toLowerCase().indexOf(text) !== -1; });
    var inputId = label && label.getAttribute("for");
    var input = inputId && document.getElementById(inputId);
    if (input && sheet.contains(input)) return input;
    throw new Error("OIC did not expose the " + text + " checkbox for verification.");
  }
  function checked(input) { return input.checked === true || input.getAttribute("aria-checked") === "true"; }
  try {
    if (!/root=integrations(?:&|$)/i.test(location.href)) throw new Error("OIC is not on the Integrations list while verifying runtime options.");
    var row = findRow();
    if (!row) throw new Error("Could not find the exact active integration while verifying runtime options.");
    row.scrollIntoView({ block: "center" });
    row.click();
    await new Promise(function (resolve) { setTimeout(resolve, 350); });
    var actionButton = Array.from(row.querySelectorAll("button")).find(function (button) { return /true/i.test(String(button.getAttribute("aria-haspopup") || "")); });
    if (!actionButton) throw new Error("OIC did not expose the exact row Actions menu for runtime verification.");
    actionButton.click();
    var actionDeadline = Date.now() + 6000;
    var configure;
    while (Date.now() < actionDeadline && !configure) {
      configure = Array.from(document.querySelectorAll("oj-option,[role=menuitem],button,a")).find(function (item) {
        return visible(item) && /^configure activation$/i.test(labelOf(item));
      });
      if (!configure) await new Promise(function (resolve) { setTimeout(resolve, 200); });
    }
    if (!configure) throw new Error("OIC did not expose Configure activation for runtime verification.");
    configure.click();
    var sheetDeadline = Date.now() + 8000;
    var sheet;
    while (Date.now() < sheetDeadline && !(sheet = findSheet())) await new Promise(function (resolve) { setTimeout(resolve, 200); });
    if (!sheet) throw new Error("OIC did not open Configure activation for runtime verification.");
    var debugRadio = Array.from(sheet.querySelectorAll('input[type="radio"]')).find(function (input) {
      var label = Array.from(sheet.querySelectorAll("label")).find(function (item) { return item.getAttribute("for") === input.id; });
      return /debug/i.test(clean([input.value, label && label.textContent].filter(Boolean).join(" ")));
    });
    var allowRunAgain = findCheckbox(sheet, "allow to run again");
    var payloadValidation = findCheckbox(sheet, "enable payload validation");
    var options = { debug: !!(debugRadio && checked(debugRadio)), allowRunAgain: checked(allowRunAgain), payloadValidation: checked(payloadValidation) };
    // Runtime settings are enable-only. An unchecked extension preference means
    // "leave the current OIC value unchanged", never "turn it off".
    var matches = options.debug
      && (!prefs.allowRunAgain || options.allowRunAgain)
      && (!prefs.payloadValidation || options.payloadValidation);
    var cancel = Array.from(sheet.querySelectorAll("button")).find(function (button) { return visible(button) && /^cancel$/i.test(labelOf(button)); });
    if (cancel) cancel.click();
    if (!matches) {
      return { ok: false, options: options, error: "OIC shows Debug=" + options.debug + ", Allow to run again=" + options.allowRunAgain + ", payload validation=" + options.payloadValidation + " after Save." };
    }
    return { ok: true, options: options };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}

async function refreshSource(tabId) {
  await new Promise(function (resolve) { chrome.tabs.reload(tabId, {}, resolve); });
}

async function openTargetEditor(target) {
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(element) { return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length); }
  function versionParts(value) {
    var parts = String(value || "").split(".").map(function (part) { return String(parseInt(part, 10) || 0); });
    while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
    return parts.join(".");
  }
  function findRow() {
    return Array.from(document.querySelectorAll('tr,[role="row"],oj-list-item,li')).find(function (candidate) {
      var text = clean(candidate.innerText || candidate.textContent);
      var hasVersion = text.split(/\s+/).some(function (word) { return versionParts(word.replace(/[^0-9.]/g, "")) === versionParts(target.version); });
      var exactNameLink = Array.from(candidate.querySelectorAll("a")).some(function (link) {
        return clean([link.getAttribute("aria-label"), link.getAttribute("title"), link.textContent].filter(Boolean).join(" ")).indexOf(target.name) !== -1;
      });
      return visible(candidate) && exactNameLink && hasVersion;
    });
  }
  try {
    var deadline = Date.now() + 15000;
    var row;
    while (Date.now() < deadline && !(row = findRow())) await new Promise(function (resolve) { setTimeout(resolve, 350); });
    if (!row) throw new Error("Could not relocate " + target.name + " (" + target.version + ") after deactivation.");
    var link = Array.from(row.querySelectorAll("a")).find(function (candidate) {
      return clean([candidate.getAttribute("aria-label"), candidate.getAttribute("title"), candidate.textContent].filter(Boolean).join(" ")).indexOf(target.name) !== -1;
    });
    if (!link) throw new Error("The exact integration link is unavailable.");
    link.click();
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}

async function waitForEditor(tabId, target, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 600); });
    try {
      var result = await execute(tabId, inspectEditor, [target]);
      if (result && result.ready) {
        if (result.viewOnly) return { ok: false, error: "OIC opened " + target.name + " as View only instead of edit mode." };
        return { ok: true };
      }
    } catch (_error) {
      // The OIC SPA can replace its document while the integration route loads.
    }
  }
  return { ok: false, error: "Timed out while opening " + target.name + " in edit mode." };
}

async function waitForIntegrationPage(tabId, target, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 600); });
    try {
      var result = await execute(tabId, inspectIntegrationPage, [target]);
      if (result && result.ready) return { ok: true };
    } catch (_error) {
      // The OIC SPA can replace its document while the integration route loads.
    }
  }
  return { ok: false, error: "Timed out while reopening " + target.name + "." };
}

function inspectEditor(target) {
  var text = String(document.body && document.body.innerText || "").replace(/\s+/g, " ").trim();
  var ready = /root=integration(?:&|$)/i.test(location.href) && text.indexOf(target.name) !== -1;
  return { ready: ready, viewOnly: ready && /\bView only\b/i.test(text) };
}

function inspectIntegrationPage(target) {
  var text = String(document.body && document.body.innerText || "").replace(/\s+/g, " ").trim();
  return { ready: /root=integration(?:&|$)/i.test(location.href) && text.indexOf(target.name) !== -1 };
}

// This is intentionally self-contained. `executeScript` serializes a function into an isolated
// world and does not bring lexical helpers along, so each UI operation gets an explicit state
// machine instead of depending on globals in the OIC application.
async function executeUiFlow(operation, target, prefs) {
  function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function visible(element) { var s = getComputedStyle(element); return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length) && s.visibility !== "hidden" && s.display !== "none"; }
  function labelOf(element) { return normalize([element.getAttribute("aria-label"), element.getAttribute("title"), element.value, element.textContent].filter(Boolean).join(" ")); }
  function allControls(root) { return Array.from((root || document).querySelectorAll('button,a,[role="button"],input,oj-button,oj-menu-button,oj-option,[role="menuitem"]')); }
  function controls(root) { return allControls(root).filter(visible); }
  function findNamed(names, root, allowContains) { return controls(root).find(function (candidate) { var label = labelOf(candidate).toLowerCase(); return names.some(function (name) { return label === name || (allowContains && label.indexOf(name) !== -1); }); }); }
  function findNamedIncludingHidden(names, root, allowContains) { return allControls(root).find(function (candidate) { var label = labelOf(candidate).toLowerCase(); return names.some(function (name) { return label === name || (allowContains && label.indexOf(name) !== -1); }); }); }
  function rowLinks(root) {
    // `allControls` intentionally includes custom OJ components and their nested
    // native elements.  That is useful for named dialogs, but it makes the icon
    // sequence in a row ambiguous.  OIC renders each row action as exactly one
    // anchor, so use anchors only when calculating row-relative actions. OIC
    // keeps those anchors in the exact row DOM while hiding them until a trusted
    // hover; extension-generated hover events cannot satisfy that requirement,
    // so include hidden anchors after the row itself has been uniquely matched.
    return Array.from(root.querySelectorAll("a"));
  }
  function rowActionMenu(root) {
    var named = findNamedIncludingHidden(["actions", "action menu", "more actions", "show actions", "more options"], root, true);
    if (named) return named;
    var links = rowLinks(root);
    var popup = links.find(function (candidate) { return /menu|true/i.test(String(candidate.getAttribute("aria-haspopup") || "")); });
    if (popup) return popup;
    // OIC's current list uses an icon-only overflow link between View and Open Details.
    // Its accessible name is only the glyph, so identify it by its stable neighbours.
    var detailsIndex = links.findIndex(function (candidate) { return /open details/i.test(labelOf(candidate)); });
    return detailsIndex > 0 ? links[detailsIndex - 1] : null;
  }
  function rowPrimaryAction(root) {
    // In the current OIC list the exact row's icon actions appear in a stable
    // sequence: primary action, overflow, Open Details.  The primary action
    // has only an icon in the DOM (its accessible Help text is not exposed to
    // content scripts), so matching it by its visible text is unreliable.
    // Derive it only from the already exact-matched row and the Open Details
    // anchor immediately following the overflow control.
    var links = rowLinks(root);
    var detailsIndex = links.findIndex(function (candidate) { return /open details/i.test(labelOf(candidate)); });
    return detailsIndex > 1 ? links[detailsIndex - 2] : null;
  }
  function findActivationDialog() {
    function matches(candidate) {
      if (!candidate || !visible(candidate)) return false;
      var text = normalize(candidate.innerText || candidate.textContent);
      if (text.indexOf(target.name) === -1 || !/select tracing level|configure activation|tracing level/i.test(text)) return false;
      var scopedControls = controls(candidate);
      var hasTracingChoice = scopedControls.some(function (item) {
        return /^(production|audit|debug)(\s|$)/i.test(labelOf(item));
      });
      var hasSubmit = scopedControls.some(function (item) {
        return /^(activate|save)$/i.test(labelOf(item));
      });
      return hasTracingChoice && hasSubmit;
    }
    var semantic = Array.from(document.querySelectorAll('[role="dialog"],oj-dialog')).find(matches);
    if (semantic) return semantic;

    // OIC 3 currently renders its right-side activation sheet as an ordinary
    // container with no dialog role. Start at its exact Activate/Save submit button
    // and return the smallest visible ancestor that contains this integration's
    // title and tracing choices. This remains scoped to the already verified
    // target row and cannot match a different integration behind the sheet.
    var submitButtons = controls().filter(function (item) {
      return /^(activate|save)$/i.test(labelOf(item));
    });
    for (var i = 0; i < submitButtons.length; i += 1) {
      var ancestor = submitButtons[i].parentElement;
      while (ancestor && ancestor !== document.body) {
        if (matches(ancestor)) return ancestor;
        ancestor = ancestor.parentElement;
      }
    }
    return null;
  }
  function openActionMenu(element) {
    // OIC wraps the real menu trigger in a zero-sized <oj-menu-button>. Pointer
    // events sent to that wrapper never reach Oracle JET's internal native
    // button, so the hidden menu stays closed. Target the internal button first;
    // this is the same exact row-scoped Actions control already safety-checked.
    if (!element) return false;
    var nativeButton = element.matches && element.matches("button") ? element : element.querySelector && element.querySelector("button");
    if (nativeButton) {
      nativeButton.click();
      return true;
    }
    var box = element.getBoundingClientRect();
    var eventOptions = { bubbles: true, cancelable: true, view: window, clientX: box.left + (box.width / 2), clientY: box.top + (box.height / 2), button: 0, buttons: 1 };
    try { element.dispatchEvent(new PointerEvent("pointerdown", eventOptions)); } catch (ignore) {}
    element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    try { element.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, eventOptions, { buttons: 0 }))); } catch (ignore2) {}
    element.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, eventOptions, { buttons: 0 })));
    element.dispatchEvent(new MouseEvent("click", Object.assign({}, eventOptions, { buttons: 0 })));
    return true;
  }
  function clickNamed(names, root, allowContains) { var candidate = findNamed(names, root, allowContains); if (!candidate) return false; candidate.click(); return true; }
  async function eventually(check, timeoutMs, message) { var until = Date.now() + timeoutMs; while (Date.now() < until) { var result = await check(); if (result) return result; await sleep(350); } throw new Error(message); }
  function setCheckbox(text, value) { var box = controls().find(function (item) { return labelOf(item).toLowerCase().indexOf(text) !== -1; }); if (!box) return; var checked = box.checked === true || box.getAttribute("aria-checked") === "true"; if (checked !== value) box.click(); }
  function versionParts(value) {
    var parts = String(value || "").split(".").map(function (part) { return String(parseInt(part, 10) || 0); });
    while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
    return parts.join(".");
  }
  function findTargetRow() {
    var normalizedVersion = versionParts(target.version);
    function isTargetScope(candidate) {
      var text = normalize(candidate.innerText || candidate.textContent);
      var hasVersion = text.split(/\s+/).some(function (word) { return versionParts(word.replace(/[^0-9.]/g, "")) === normalizedVersion; });
      return visible(candidate) && text.indexOf(target.name) !== -1 && hasVersion;
    }
    // Start from the exact integration-name link and walk only as far as its own
    // row.  The previous broad table selector could return an ancestor containing
    // several rows; that made icon offsets point at the overflow menu.
    var targetLink = Array.from(document.querySelectorAll("a")).find(function (link) {
      return visible(link) && normalize(labelOf(link)) === normalize(target.name);
    });
    if (targetLink) {
      var ancestor = targetLink.parentElement;
      while (ancestor && ancestor !== document.body) {
        var detailLinks = rowLinks(ancestor).filter(function (link) { return /open details/i.test(labelOf(link)); });
        if (isTargetScope(ancestor) && detailLinks.length === 1) return ancestor;
        ancestor = ancestor.parentElement;
      }
    }
    return Array.from(document.querySelectorAll('tr,[role="row"],oj-list-item,li')).find(isTargetScope);
  }
  try {
    // OPEN_INTEGRATIONS
    await eventually(function () { return document.body && document.body.innerText; }, 15000, "OIC did not become ready. Sign in to OIC in the helper tab.");
    if (!clickNamed(["integrations"])) {
      if (clickNamed(["design"])) { await sleep(700); clickNamed(["integrations"]); }
    }
    await eventually(function () { return /root=integration/i.test(location.href) || /\b\d+\s+integrations\b/i.test(document.body.innerText); }, 15000, "Design navigation does not expose the Integrations page.");

    // LOCATE_TARGET: use an already-visible exact row before touching OIC's filters. The
    // filter component can remain behind a blocking spinner when several filter changes are
    // dispatched quickly, even though the desired row is already present.
    var identity = (target.code || target.name) + "|" + target.version;
    var row = findTargetRow();
    if (!row) {
      var clear = findNamed(["clear"]);
      if (clear) { clear.click(); await sleep(1200); }
      clickNamed(["open input search", "search"], document, true);
      await sleep(400);
      var search = controls().find(function (item) { return (item.tagName === "INPUT" || item.getAttribute("contenteditable") === "true") && /search|filter|full or partial integration/i.test(labelOf(item)); });
      if (search) {
        search.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, target.name);
        search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: target.name }));
        search.dispatchEvent(new Event("change", { bubbles: true }));
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      row = await eventually(findTargetRow, 20000, "Integration " + identity + " was not found. Clear any unexpected list filters and verify the version.");
    }
    row.scrollIntoView({ block: "center" });
    // OIC only materializes a row's View / overflow / Open Details controls after
    // selection. This must happen before checking Locked state so that the exact
    // row's current status is available.
    row.click();
    ["mouseover", "mouseenter", "pointerover", "pointerenter"].forEach(function (type) {
      row.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
    });
    await sleep(700);

    // Bulk Debug never unlocks integrations. Unlocking is a separate OIC action
    // with potential data-loss implications, so a Locked row is left untouched.
    // The caller reports it as skipped and the user can resolve the lock manually.
    var isActivation = operation === "activate-debug" || operation === "activate-debug-run";
    if (isActivation && /\blocked\b/i.test(normalize(row.innerText || row.textContent))) {
      return { ok: true, submitted: false, status: "skipped-locked" };
    }

    // OPEN_ACTION / SUBMIT. OIC keeps row action links in the DOM but reveals them only
    // after a trusted pointer hover. Extension-generated hover events are not trusted, so
    // prefer the action that belongs to the exact matched row even when it is still hidden.
    // The exact row was selected above, so its OIC action links are materialized.
    if (isActivation) {
      var rowActivationText = normalize(row.innerText || row.textContent);
      var wasActive = /\bactive\b/i.test(rowActivationText);
      if (prefs.requireActive && !wasActive) {
        return { ok: true, submitted: false, status: "skipped-not-active" };
      }
      var activationAction;
      if (wasActive) {
        // The visible primary action for an Active integration is Deactivate.
        // Configure activation lives in the row's Actions menu; never use the
        // primary icon for this branch or a bulk Debug action could deactivate it.
        var activationMenu = rowActionMenu(row) || findNamedIncludingHidden(["actions", "action menu", "more actions", "show actions", "more options"], row, true);
        if (!activationMenu) throw new Error("The exact integration row has no Actions menu.");
        openActionMenu(activationMenu);
        activationAction = await eventually(function () { return findNamed(["configure activation"], document, true); }, 5000, "OIC did not expose Configure activation in the exact row menu.");
      } else {
        activationAction = rowPrimaryAction(row) || findNamedIncludingHidden(["activate"], row, true);
        if (!activationAction) {
          var inactiveMenu = rowActionMenu(row) || findNamedIncludingHidden(["actions", "action menu", "more actions", "show actions", "more options"], row, true);
          if (inactiveMenu) { openActionMenu(inactiveMenu); await sleep(300); }
          activationAction = findNamed(["activate"], document);
        }
      }
      if (!activationAction) throw new Error((wasActive ? "Configure activation" : "Activate") + " is unavailable for " + identity + ".");
      activationAction.click();
      var activationDialog = await eventually(findActivationDialog, 8000, "The activation settings dialog did not open.");
      // These actions are explicitly named Activate Debug / Save, Activate Debug & Run.
      // Never let an older saved Production/Audit preference override that promise.
      var tracing = "debug";
      var traceInput = controls(activationDialog).find(function (item) {
        return item.tagName === "INPUT" && item.type === "radio" && normalize(item.value).toLowerCase() === tracing;
      });
      var trace = traceInput || Array.from(activationDialog.querySelectorAll("label")).filter(visible).find(function (item) {
        var label = normalize(item.textContent).toLowerCase();
        return label === tracing || label.indexOf(tracing + " ") === 0;
      }) || controls(activationDialog).find(function (item) { var label = labelOf(item).toLowerCase(); return label === tracing || label.indexOf(tracing + " ") === 0; });
      if (!trace) throw new Error("Could not select the saved " + tracing + " tracing level.");
      var traceWasSelected = traceInput ? traceInput.checked === true : controls(activationDialog).some(function (item) {
        var label = labelOf(item).toLowerCase();
        var selected = item.checked === true || item.getAttribute("aria-checked") === "true" || item.getAttribute("data-oj-selected") === "true";
        return selected && (label === tracing || label.indexOf(tracing + " ") === 0);
      });
      var traceChanged = !traceWasSelected;
      if (traceChanged) trace.click();
      await eventually(function () {
        if (traceInput) return traceInput.checked === true;
        return controls(activationDialog).some(function (item) {
          var label = labelOf(item).toLowerCase();
          var selected = item.checked === true || item.getAttribute("aria-checked") === "true" || item.getAttribute("data-oj-selected") === "true";
          return selected && (label === tracing || label.indexOf(tracing + " ") === 0);
        });
      }, 4000, "OIC kept Production selected, so activation was stopped before submission.");
      function findDialogCheckbox(text) {
        var semanticLabel = Array.from(activationDialog.querySelectorAll("label")).filter(visible).find(function (item) {
          return normalize(item.textContent).toLowerCase().indexOf(text) !== -1;
        });
        // Prefer the real input addressed by OIC's label. The broad controls()
        // lookup can find a JET wrapper whose aria state does not represent the
        // underlying native checkbox, causing an already checked option to be
        // clicked (and therefore toggled off).
        if (semanticLabel) {
          var inputId = semanticLabel.getAttribute("for");
          var labeledInput = inputId && document.getElementById(inputId);
          if (labeledInput && activationDialog.contains(labeledInput) && labeledInput.tagName === "INPUT" && labeledInput.type === "checkbox") return labeledInput;
          var nestedInput = semanticLabel.querySelector('input[type="checkbox"]');
          if (nestedInput) return nestedInput;
        }
        throw new Error("Could not find OIC's native " + text + " checkbox.");
      }
      function dialogCheckboxChecked(text) {
        var box = findDialogCheckbox(text);
        return box.checked === true;
      }
      async function setDialogCheckbox(text, value) {
        var box = findDialogCheckbox(text);
        var checked = box.checked === true;
        var changed = checked !== value;
        // OIC renders these as native inputs inside <oj-checkboxset>. Calling
        // click() on the associated label does not reliably reach Oracle JET's
        // value binding from an extension execution world. Click the exact
        // native checkbox instead; HTMLElement.click() performs the checkbox's
        // default toggle and emits its input/change lifecycle.
        if (!changed) return { text: text, changed: false, value: value };
        box.click();
        // Updating one option can cause Oracle JET to replace both native
        // inputs. Set and confirm each option before touching the next one;
        // rapid back-to-back clicks were the source of one runtime option
        // being silently dropped for some integrations.
        await sleep(350);
        if (dialogCheckboxChecked(text) !== value) {
          // Do not assign .checked or perform a second blind click. Either can
          // desynchronise OIC's JET model or toggle a correct option off.
          throw new Error("OIC did not apply " + text + " after one checked-state change, so Save was stopped.");
        }
        await eventually(function () { return dialogCheckboxChecked(text) === value; }, 3500, "OIC did not apply " + text + ", so Save was stopped.");
        await sleep(250);
        return { text: text, changed: changed, value: value };
      }
      var runtimeOptions = [];
      if (!prefs.preserveActivationOptions) {
        // Enable-only behavior: neither setting is ever used to uncheck an OIC
        // checkbox. A disabled preference simply preserves the integration's
        // existing runtime option.
        if (prefs.allowRunAgain) runtimeOptions.push(await setDialogCheckbox("allow to run again", true));
        if (prefs.payloadValidation) runtimeOptions.push(await setDialogCheckbox("enable payload validation", true));
        await eventually(function () {
          return runtimeOptions.every(function (option) {
            return dialogCheckboxChecked(option.text) === option.value;
          });
        }, 4000, "OIC did not apply the saved runtime options, so Save was stopped.");
      }
      var activationChanged = traceChanged || runtimeOptions.some(function (option) { return option.changed; });
      if (wasActive && !activationChanged) {
        var activationCancel = Array.from(activationDialog.querySelectorAll("button")).filter(visible).find(function (button) {
          return labelOf(button).toLowerCase() === "cancel";
        });
        if (!activationCancel) throw new Error("The unchanged activation settings sheet has no Cancel button.");
        activationCancel.click();
        await eventually(function () { return !findActivationDialog(); }, 5000, "OIC did not close the unchanged activation settings sheet.");
        return { ok: true, submitted: false, status: "skipped-already-configured" };
      }
      // Let Oracle JET commit the radio/checkbox model before Save reads it.
      await sleep(800);
      if (traceInput && traceInput.checked !== true) {
        throw new Error("OIC changed Debug back to another tracing level, so Save was stopped.");
      }
      var submitButton = Array.from(activationDialog.querySelectorAll("button")).filter(visible).find(function (button) {
        return labelOf(button).toLowerCase() === (wasActive ? "save" : "activate");
      });
      if (!submitButton) throw new Error("Could not submit activation settings.");

      function activationSubmissionAccepted() {
        if (!findActivationDialog()) return true;
        var pageText = normalize(document.body && document.body.innerText || "");
        // Configure activation is different from a fresh activation: OIC keeps
        // the sheet open after Save and adds a confirmation above it. Treat that
        // confirmation as acceptance; the later reload/row verification remains
        // the source of truth for the persisted Debug state.
        return /activation in progress|activating|were updated successfully|tracing is enabled(?: with payload)?/i.test(pageText);
      }
      function activationSubmissionStarted() {
        var ojHost = submitButton.closest && submitButton.closest("oj-button");
        return activationSubmissionAccepted()
          || submitButton.disabled === true
          || submitButton.getAttribute("aria-disabled") === "true"
          || (ojHost && ojHost.getAttribute("disabled") !== null);
      }

      submitButton.click();
      // Oracle JET's <oj-button> does not always translate HTMLElement.click()
      // into its ojAction callback. Give the normal click a chance first, then
      // invoke the component action once as a guarded fallback. This mirrors the
      // trusted Save interaction without changing which exact dialog/button was
      // selected by the safety checks above.
      var quickDeadline = Date.now() + 1800;
      while (Date.now() < quickDeadline && !activationSubmissionStarted()) await sleep(200);
      if (!activationSubmissionStarted()) {
        var ojButton = submitButton.closest && submitButton.closest("oj-button");
        if (ojButton) {
          ojButton.dispatchEvent(new CustomEvent("ojAction", {
            bubbles: true,
            cancelable: true,
            detail: { originalEvent: new MouseEvent("click", { bubbles: true, cancelable: true, view: window }) }
          }));
        }
      }
      await eventually(activationSubmissionAccepted, 8000, "OIC did not accept the Activate/Save submission.");
    } else {
      var rowStatus = normalize(row.innerText || row.textContent).toLowerCase();
      if (operation === "edit" && /\bconfigured\b|\binactive\b|\bdraft\b/.test(rowStatus)) {
        return { ok: true, submitted: false, status: "configured" };
      }
      var deactivateAction = findNamedIncludingHidden(["deactivate"], row, true);
      if (!deactivateAction) {
        var deactivateMenu = rowActionMenu(row);
        if (deactivateMenu) { openActionMenu(deactivateMenu); await sleep(300); }
        deactivateAction = await eventually(function () { return findNamed(["deactivate"]); }, 4000, "OIC did not expose Deactivate in the exact row menu.");
      }
      if (!deactivateAction) throw new Error("Deactivate is unavailable for " + identity + ".");
      deactivateAction.click();
      var dialog = await eventually(function () { return Array.from(document.querySelectorAll('[role="dialog"],oj-dialog')).find(visible); }, 8000, "The deactivation confirmation did not open.");
      var dialogText = normalize(dialog.innerText || dialog.textContent);
      var expectedVersion = versionParts(target.version);
      var dialogVersionMatches = dialogText.split(/\s+/).some(function (word) {
        return versionParts(word.replace(/[^0-9.]/g, "")) === expectedVersion;
      });
      if (dialogText.indexOf(target.name) === -1 || !dialogVersionMatches) {
        var cancel = findNamed(["cancel"], dialog);
        if (cancel) cancel.click();
        throw new Error("Safety check stopped deactivation because OIC's confirmation did not name " + target.name + " (" + target.version + ").");
      }
      if (/warning|pending|scheduled|lost/i.test(dialogText) && !/deactivate/i.test(dialogText)) {
        throw new Error("OIC displayed an unexpected warning; no automatic confirmation was made.");
      }
      var confirm = findNamed(["deactivate"], dialog);
      if (!confirm) throw new Error("The verified deactivation confirmation has no Deactivate button.");
      confirm.click();
    }
    return { ok: true, submitted: true };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}
