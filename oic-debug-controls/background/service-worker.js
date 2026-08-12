/* global importScripts, chrome, OicTargets */
importScripts("../shared/targets.js");

var DEFAULTS = { tracingLevel: "debug", allowRunAgain: true, payloadValidation: false };
var activeOperations = new Map();

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get(DEFAULTS, function (stored) { chrome.storage.local.set(stored); });
});

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
  if (message.type === "oic:open-helper") {
    if (Number.isInteger(message.tabId)) chrome.tabs.update(message.tabId, { active: true });
  }
});

function serializeError(error) {
  return { message: error && error.message ? error.message : String(error), helperTabId: error && error.helperTabId };
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
    setTimeout(function () { activeOperations.delete(target.key); publishState(target.key); }, 3000);
    return result;
  } catch (error) {
    state.error = error.message || String(error);
    state.helperTabId = error.helperTabId || state.helperTabId;
    publishState(target.key);
    // An explicit new user click may retry after a safe, pre-submission failure. Keep the
    // helper tab available for review, but never leave a stale in-progress lock behind.
    activeOperations.delete(target.key);
    publishState(target.key);
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

function publishState(key) {
  chrome.tabs.query({ url: "https://design.integration.ap-hyderabad-1.ocp.oraclecloud.com/*" }, function (tabs) {
    tabs.forEach(function (tab) { chrome.tabs.sendMessage(tab.id, { type: "oic:state", key: key, state: activeOperations.get(key) || null }).catch(function () {}); });
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
  var hostTabs = await new Promise(function (resolve) {
    chrome.tabs.query({ url: "https://design.integration.ap-hyderabad-1.ocp.oraclecloud.com/*" }, resolve);
  });
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
    : await chrome.tabs.create({ url: helperUrl.toString(), active: false, openerTabId: source.id });
  state.helperTabId = helper.id;
  if (helper.id !== source.id) await waitForTab(helper.id, 30000);
  state.phase = operation === "activate-debug" || operation === "activate-debug-run" ? "Opening Integrations and activating debug…" : operation === "edit" ? "Checking integration status…" : "Opening Integrations and deactivating…";
  publishState(target.key);
  var submitted = await execute(helper.id, executeUiFlow, [operation, target, prefs]);
  if (!submitted || !submitted.ok) throw withHelper(new Error((submitted && submitted.error) || "OIC did not accept the operation. Review the helper tab."), helper.id);
  if (submitted.unlocked) {
    state.phase = "Waiting for OIC to unlock…";
    publishState(target.key);
    var unlocked = await verifyUnlockedWithReloads(helper.id, target, 60000);
    if (!unlocked.ok) throw withHelper(new Error(unlocked.error || "OIC did not clear the Locked state. Review the helper tab."), helper.id);
    state.phase = "Activating Debug…";
    publishState(target.key);
    submitted = await execute(helper.id, executeUiFlow, [operation, target, prefs]);
    if (!submitted || !submitted.ok || !submitted.submitted) throw withHelper(new Error((submitted && submitted.error) || "OIC did not accept Debug activation after unlocking."), helper.id);
  }
  var verified = { ok: true, status: submitted.status || "configured" };
  if (submitted.submitted) {
    state.phase = "Waiting for OIC to finish…";
    publishState(target.key);
    verified = await verifyWithReloads(helper.id, operation === "edit" ? "deactivate" : operation === "activate-debug-run" ? "activate-debug" : operation, target, 90000);
    if (!verified.ok) throw withHelper(new Error(verified.error || "OIC did not reach the expected status. Review the helper tab."), helper.id);
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
  await chrome.tabs.remove(helper.id);
  return { status: verified.status, target: target };
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

async function verifyUnlockedWithReloads(tabId, target, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 1800); });
    await new Promise(function (resolve) { chrome.tabs.reload(tabId, {}, resolve); });
    await waitForTab(tabId, 30000);
    var result = await execute(tabId, inspectUnlockedStatus, [target]);
    if (result && result.ok) return result;
  }
  return { ok: false, error: "Timed out waiting for OIC to clear the Locked state for " + (target.code || target.name) + "." };
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

async function inspectUnlockedStatus(target) {
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(element) { return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length); }
  function versionParts(value) {
    var parts = String(value || "").split(".").map(function (part) { return String(parseInt(part, 10) || 0); });
    while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
    return parts.join(".");
  }
  var row = Array.from(document.querySelectorAll('tr,[role="row"],oj-list-item,li')).find(function (candidate) {
    var text = clean(candidate.innerText || candidate.textContent);
    return visible(candidate) && text.indexOf(target.name) !== -1 && text.split(/\s+/).some(function (word) { return versionParts(word.replace(/[^0-9.]/g, "")) === versionParts(target.version); });
  });
  if (!row) return { ok: false, error: "The exact integration is not visible after unlocking." };
  return /\blocked\b/i.test(clean(row.innerText || row.textContent))
    ? { ok: false, status: "locked" }
    : { ok: true, status: "unlocked" };
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
      var hasActivate = scopedControls.some(function (item) {
        return /^activate$/i.test(labelOf(item));
      });
      return hasTracingChoice && hasActivate;
    }
    var semantic = Array.from(document.querySelectorAll('[role="dialog"],oj-dialog')).find(matches);
    if (semantic) return semantic;

    // OIC 3 currently renders its right-side activation sheet as an ordinary
    // container with no dialog role. Start at its exact Activate submit button
    // and return the smallest visible ancestor that contains this integration's
    // title and tracing choices. This remains scoped to the already verified
    // target row and cannot match a different integration behind the sheet.
    var activateButtons = controls().filter(function (item) {
      return /^activate$/i.test(labelOf(item));
    });
    for (var i = 0; i < activateButtons.length; i += 1) {
      var ancestor = activateButtons[i].parentElement;
      while (ancestor && ancestor !== document.body) {
        if (matches(ancestor)) return ancestor;
        ancestor = ancestor.parentElement;
      }
    }
    return null;
  }
  function openActionMenu(element) {
    // OIC's icon-only row overflow listens to the pointer lifecycle. Calling
    // HTMLElement.click() alone selects the row but does not open the menu.
    // Keep the event targeted at the already exact-matched action element.
    if (!element) return false;
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
    // selection. This must happen before Locked handling, otherwise Unlock cannot
    // be found even though the exact target row was located successfully.
    row.click();
    ["mouseover", "mouseenter", "pointerover", "pointerenter"].forEach(function (type) {
      row.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
    });
    await sleep(700);

    // A previously open editor can leave an integration Locked even after its tab has
    // gone away. For an explicit Debug activation request, unlock only the already
    // exact-matched row, confirm OIC names that exact integration/version, and wait for
    // the Locked state to clear before exposing the activation action.
    var isActivation = operation === "activate-debug" || operation === "activate-debug-run";
    if (isActivation && /\blocked\b/i.test(normalize(row.innerText || row.textContent))) {
      var unlockAction = findNamedIncludingHidden(["unlock"], row, true);
      if (!unlockAction) {
        var unlockMenu = rowActionMenu(row);
        if (unlockMenu) { openActionMenu(unlockMenu); await sleep(300); }
        unlockAction = await eventually(function () { return findNamed(["unlock"], document, true); }, 4000, "OIC did not expose Unlock in the exact row menu.");
      }
      if (!unlockAction) throw new Error("OIC reports " + identity + " as Locked, but its Unlock action is unavailable.");
      unlockAction.click();
      var unlockDialog = await eventually(function () { return Array.from(document.querySelectorAll('[role="dialog"],oj-dialog')).find(visible); }, 8000, "The Unlock confirmation did not open.");
      var unlockText = normalize(unlockDialog.innerText || unlockDialog.textContent);
      var unlockVersionMatches = unlockText.split(/\s+/).some(function (word) {
        return versionParts(word.replace(/[^0-9.]/g, "")) === versionParts(target.version);
      });
      if (unlockText.indexOf(target.name) === -1 || !unlockVersionMatches || !/\bunlock\b/i.test(unlockText)) {
        var unlockCancel = findNamed(["cancel"], unlockDialog);
        if (unlockCancel) unlockCancel.click();
        throw new Error("Safety check stopped unlocking because OIC's confirmation did not name " + target.name + " (" + target.version + ").");
      }
      var unlockConfirm = findNamed(["unlock"], unlockDialog);
      if (!unlockConfirm) throw new Error("The verified Unlock confirmation has no Unlock button.");
      unlockConfirm.click();
      // Stop here. OIC can retain a stale row/action model immediately after unlocking;
      // the background state machine reloads, verifies Configured/unlocked, then invokes
      // this guarded flow again for the single activation submission.
      return { ok: true, unlocked: true, submitted: false };
    }

    // OPEN_ACTION / SUBMIT. OIC keeps row action links in the DOM but reveals them only
    // after a trusted pointer hover. Extension-generated hover events are not trusted, so
    // prefer the action that belongs to the exact matched row even when it is still hidden.
    // The exact row was selected above, so its OIC action links are materialized.
    if (isActivation) {
      var wasActive = /\bactive\b/i.test(normalize(row.innerText || row.textContent));
      var activationAction = rowPrimaryAction(row) || (wasActive
        ? findNamedIncludingHidden(["configure activation", "tracing"], row, true)
        : findNamedIncludingHidden(["activate"], row, true));
      if (!activationAction) {
        var activationMenu = rowActionMenu(row) || findNamedIncludingHidden(["actions", "action menu", "more actions", "show actions", "more options"], row, true);
        if (activationMenu) { openActionMenu(activationMenu); await sleep(300); }
        activationAction = wasActive ? findNamed(["configure activation", "tracing"], document, true) : findNamed(["activate"], document);
      }
      if (!activationAction) throw new Error((wasActive ? "Configure activation" : "Activate") + " is unavailable for " + identity + ".");
      activationAction.click();
      var activationDialog = await eventually(findActivationDialog, 8000, "The activation settings dialog did not open.");
      // These actions are explicitly named Activate Debug / Save, Activate Debug & Run.
      // Never let an older saved Production/Audit preference override that promise.
      var tracing = "debug";
      var trace = Array.from(activationDialog.querySelectorAll("label")).filter(visible).find(function (item) {
        var label = normalize(item.textContent).toLowerCase();
        return label === tracing || label.indexOf(tracing + " ") === 0;
      }) || controls(activationDialog).find(function (item) { var label = labelOf(item).toLowerCase(); return label === tracing || label.indexOf(tracing + " ") === 0; });
      if (!trace) throw new Error("Could not select the saved " + tracing + " tracing level.");
      trace.click();
      await eventually(function () {
        return controls(activationDialog).some(function (item) {
          var label = labelOf(item).toLowerCase();
          var selected = item.checked === true || item.getAttribute("aria-checked") === "true" || item.getAttribute("data-oj-selected") === "true";
          return selected && (label === tracing || label.indexOf(tracing + " ") === 0);
        });
      }, 4000, "OIC kept Production selected, so activation was stopped before submission.");
      function setDialogCheckbox(text, value) {
        var semanticLabel = Array.from(activationDialog.querySelectorAll("label")).filter(visible).find(function (item) {
          return normalize(item.textContent).toLowerCase().indexOf(text) !== -1;
        });
        var box = controls(activationDialog).find(function (item) { return labelOf(item).toLowerCase().indexOf(text) !== -1; });
        if (!box) return;
        var checked = box.checked === true || box.getAttribute("aria-checked") === "true";
        if (checked !== value) (semanticLabel || box).click();
      }
      setDialogCheckbox("allow to run again", !!prefs.allowRunAgain);
      setDialogCheckbox("enable payload validation", !!prefs.payloadValidation);
      await sleep(300);
      var submitButton = Array.from(activationDialog.querySelectorAll("button")).filter(visible).find(function (button) {
        return labelOf(button).toLowerCase() === (wasActive ? "save" : "activate");
      });
      if (!submitButton) throw new Error("Could not submit activation settings.");
      submitButton.click();
      await eventually(function () {
        if (!findActivationDialog()) return true;
        var pageText = normalize(document.body && document.body.innerText || "");
        return /activation in progress|activating/i.test(pageText);
      }, 8000, "OIC did not accept the Activate submission.");
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
