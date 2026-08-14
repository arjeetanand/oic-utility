/* global chrome, OicTargets */
(function () {
  "use strict";
  // Dynamic host registration may also inject this file into an already open tab.
  // Keep exactly one observer and one set of controls per OIC document.
  if (window.__oicDebugControlsLoaded) return;
  window.__oicDebugControlsLoaded = true;
  var ROOT_ID = "oic-debug-controls-root";
  var states = new Map();
  var bulkState = null;
  var observer;

  chrome.runtime.onMessage.addListener(function (message) {
    if (message.type === "oic:state") { states.set(message.key, message.state); render(); }
    if (message.type === "oic:bulk-state") { bulkState = message.state; render(); }
  });

  function send(message) { return new Promise(function (resolve) { chrome.runtime.sendMessage(message, resolve); }); }
  function currentUrl() { return window.location.href; }
  // A toast on the Integrations list says "go to Instances", so checking page text
  // incorrectly mounted an Edit button beside every integration name. Route is the
  // authoritative signal for this view.
  function isInstances() { return OicTargets.isInstancesUrl(currentUrl()); }
  function isIntegrations() { return /[?&]root=integrations(?:&|$)/i.test(currentUrl()); }
  function isEditor() { return /root=integration(?:&|$)/i.test(currentUrl()) && !/root=integrations(?:&|$)/i.test(currentUrl()); }
  function isRun() { return OicTargets.isRunUrl(currentUrl()); }
  function elementText(element) { return OicTargets.clean([element.getAttribute && element.getAttribute("aria-label"), element.getAttribute && element.getAttribute("title"), element.textContent].filter(Boolean).join(" ")); }
  function visible(element) { return !!(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)); }
  function ensureRoot() { var root = document.getElementById(ROOT_ID); if (!root) { root = document.createElement("div"); root.id = ROOT_ID; root.className = "oic-debug-controls"; document.body.appendChild(root); } return root; }
  function button(label, className, handler, disabled) {
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "oic-debug-button " + className; btn.textContent = label; btn.disabled = !!disabled;
    if (className.indexOf("oic-edit") !== -1) btn.title = "Open this integration in a new tab";
    // OIC header controls can have delegated click handlers. Keep injected controls from
    // bubbling into a neighbouring native Run button or any parent toolbar command.
    btn.addEventListener("click", function (event) {
      event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation();
      handler(event);
    });
    return btn;
  }
  function targetControl(target, compact) {
    var wrap = document.createElement("span"); wrap.className = compact ? "oic-row-control" : "oic-header-control";
    var state = states.get(target.key);
    var busy = state && !state.complete && !state.error;
    if (busy) { wrap.appendChild(Object.assign(document.createElement("span"), { className: "oic-status", textContent: state.phase })); return wrap; }
    wrap.appendChild(button("Edit", "oic-edit", function () { requestOperation("edit", target); }, busy));
    return wrap;
  }
  async function requestOperation(operation, target) {
    if (operation === "edit" && !window.confirm("Open " + (target.name || target.code) + " (" + target.version + ") for editing?\n\nIf it is Active, OIC will deactivate it first. New messages will stop and pending unprocessed requests may be lost.")) return;
    if (operation === "activate-debug-run" && !window.confirm("Save changes, activate " + target.name + " (" + target.version + ") with Debug tracing, then open its Run page?\n\nLocked integrations are left untouched and must be resolved manually in OIC. Debug tracing is reset by Oracle after 24 hours.")) return;
    var result = await send({ type: "oic:start", operation: operation, target: target });
    if (!result || !result.ok) showError((result && result.error) || { message: "Could not start OIC automation." });
  }
  function showError(error) {
    var toast = document.createElement("div"); toast.className = "oic-toast oic-toast-error"; toast.textContent = error.message;
    if (error.helperTabId) { var open = button("Open helper tab", "oic-open-helper", function () { chrome.runtime.sendMessage({ type: "oic:open-helper", tabId: error.helperTabId }); toast.remove(); }); toast.appendChild(open); }
    ensureRoot().appendChild(toast); setTimeout(function () { toast.remove(); }, 16000);
  }
  function showSuccess(message) {
    var toast = document.createElement("div"); toast.className = "oic-toast oic-toast-success"; toast.textContent = message;
    ensureRoot().appendChild(toast); setTimeout(function () { toast.remove(); }, 12000);
  }
  function crossCheckMessage(results) {
    var verified = (results || []).filter(function (item) { return item.verification; });
    // A failed or skipped batch may have no read-back values. That is not a
    // runtime-settings result and must not be shown as a misleading success toast.
    if (!verified.length) return null;
    var debug = verified.filter(function (item) { return item.verification.debug; });
    var payload = verified.filter(function (item) { return item.verification.payloadValidation; });
    var payloadOff = verified.filter(function (item) { return !item.verification.payloadValidation; }).map(function (item) { return item.target.name; });
    var message = "Cross-check: Debug " + debug.length + "/" + verified.length + "; payload validation enabled " + payload.length + "/" + verified.length + ".";
    if (payloadOff.length) message += " Payload off: " + payloadOff.join(", ") + ".";
    return message;
  }
  function rememberBulkCrossCheck(results) {
    var message = crossCheckMessage(results);
    if (!message) return;
    try { sessionStorage.setItem("oic-bulk-cross-check", message); } catch (_error) {}
  }
  function showRememberedBulkCrossCheck() {
    try {
      var message = sessionStorage.getItem("oic-bulk-cross-check");
      if (message) { sessionStorage.removeItem("oic-bulk-cross-check"); showSuccess(message); }
    } catch (_error) {}
  }
  async function runtimeOptionsSnapshot() {
    var response = await send({ type: "oic:get-runtime-options" });
    if (!response || !response.ok || !response.runtimeOptions) throw new Error("Could not read the saved runtime settings. Open extension Settings, save them, then retry.");
    return { allowRunAgain: !!response.runtimeOptions.allowRunAgain, payloadValidation: !!response.runtimeOptions.payloadValidation };
  }
  function refreshIntegrationsAfterBulk() {
    // The source tab is the user's main Integrations page. Once every bounded
    // helper operation has completed, reload that page so its list/statuses are
    // current and it remains the visible page rather than a helper tab.
    setTimeout(function () {
      if (isIntegrations() && !activationSheetVisible()) window.location.reload();
    }, 700);
  }
  function activeFilters() {
    return Array.from(document.querySelectorAll("a,button,[role=button]")).filter(function (element) {
      return visible(element) && !element.closest("#" + ROOT_ID) && /^remove filter\b/i.test(elementText(element));
    }).map(function (element) {
      var chip = element.closest("li,[role=listitem]") || element.parentElement;
      return OicTargets.clean(chip && chip.innerText || elementText(element).replace(/^remove filter\s*/i, "")).replace(/\s*[×✕]\s*$/, "");
    }).filter(Boolean);
  }
  function scanIntegrationRows(targets) {
    Array.from(document.querySelectorAll('tr[id*="|"]')).forEach(function (row) {
      if (!visible(row)) return;
      var cells = Array.from(row.querySelectorAll(":scope > td, :scope > [role=cell]"));
      if (cells.length < 2) return;
      var nameLink = cells[0].querySelector("a");
      var name = OicTargets.clean(nameLink && (nameLink.getAttribute("aria-label") || nameLink.getAttribute("title") || nameLink.textContent) || cells[0].innerText);
      var version = OicTargets.clean(cells[1].innerText || cells[1].textContent);
      var status = OicTargets.clean(cells[cells.length - 1].innerText || cells[cells.length - 1].textContent);
      var target = OicTargets.makeListTarget(row.id, name, version, status);
      if (target) targets.set(target.key, target);
    });
  }
  function bulkScopeFromLoadedRows() {
    var targets = new Map(); scanIntegrationRows(targets);
    return { filters: activeFilters(), total: OicTargets.findIntegrationCount(document.body && document.body.innerText || ""), targets: Array.from(targets.values()) };
  }
  function activationSheetVisible() {
    var hasTracingChoice = Array.from(document.querySelectorAll("label,input")).some(function (element) {
      return visible(element) && /debug(?:\s*\(not recommended\))?/i.test(elementText(element) || element.value || "");
    });
    var hasSave = Array.from(document.querySelectorAll("button,oj-button")).some(function (element) {
      return visible(element) && elementText(element).toLowerCase() === "save";
    });
    return hasTracingChoice && hasSave;
  }
  function oicOverlayVisible() {
    return Array.from(document.querySelectorAll('[role="dialog"],oj-dialog,[role="menu"],oj-menu,oj-popup')).some(function (element) {
      return visible(element);
    });
  }
  function bulkAnchor() {
    var create = Array.from(document.querySelectorAll("button,a,[role=button],oj-button")).find(function (element) {
      return visible(element) && !element.closest("#" + ROOT_ID) && elementText(element).toLowerCase() === "create";
    });
    if (!create) return null;
    // Oracle JET nests a native <button> inside <oj-button>. Inserting beside
    // that inner button corrupts the component and can disable Create itself.
    // Always use the outer OIC component as the sibling insertion point.
    return create.closest("oj-button") || create.closest("button,a,[role=button]") || create;
  }
  async function collectBulkScope() {
    var scope = bulkScopeFromLoadedRows();
    var targets = new Map(scope.targets.map(function (target) { return [target.key, target]; }));
    var table = document.querySelector('table[role="application"], table');
    var scrollers = [];
    var ancestor = table;
    while (ancestor) {
      if (ancestor.scrollHeight > ancestor.clientHeight + 5) scrollers.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    if (document.scrollingElement && scrollers.indexOf(document.scrollingElement) === -1) scrollers.push(document.scrollingElement);
    var positions = scrollers.map(function (element) { return { element: element, top: element.scrollTop }; });
    try {
      for (var pass = 0; scope.total !== null && targets.size < scope.total && pass < 160; pass += 1) {
        var moved = false;
        scrollers.forEach(function (element) {
          var maximum = Math.max(0, element.scrollHeight - element.clientHeight);
          var next = Math.min(maximum, element.scrollTop + Math.max(320, Math.floor(element.clientHeight * 0.8)));
          if (next > element.scrollTop) { element.scrollTop = next; moved = true; }
        });
        if (!moved) break;
        await new Promise(function (resolve) { setTimeout(resolve, 180); });
        scanIntegrationRows(targets);
      }
    } finally {
      positions.forEach(function (position) { position.element.scrollTop = position.top; });
    }
    if (scope.total !== null && targets.size < scope.total) {
      throw new Error("OIC reports " + scope.total + " integrations, but only " + targets.size + " loaded. Scroll through the list once, then retry so the bulk action cannot miss results.");
    }
    scope.targets = Array.from(targets.values()).filter(function (target) { return OicTargets.isActiveStatus(target.status); });
    return scope;
  }
  async function requestBulkOperation() {
    try {
      var scope = await collectBulkScope();
      if (!scope.targets.length) { showError({ message: "No currently Active integrations are in this " + (scope.filters.length ? "filtered result set." : "list.") }); return; }
      var runtimeOptions = await runtimeOptionsSnapshot();
      var scopeText = scope.filters.length ? "the current filtered results (" + scope.filters.join(", ") + ")" : "all integrations";
      var names = scope.targets.slice(0, 8).map(function (target) { return "• " + target.name + " (" + target.version + ")"; }).join("\n");
      if (scope.targets.length > 8) names += "\n• …and " + (scope.targets.length - 8) + " more";
      var runtimeText = "Allow to run again: " + (runtimeOptions.allowRunAgain ? "ENABLE if currently off" : "leave unchanged") + "\nEnable payload validation: " + (runtimeOptions.payloadValidation ? "ENABLE if currently off" : "leave unchanged");
      if (!window.confirm("Apply Debug and saved runtime settings to " + scope.targets.length + " currently Active integration" + (scope.targets.length === 1 ? "" : "s") + " from " + scopeText + "?\n\n" + names + "\n\nOIC will receive exactly (enable-only; it never unchecks these options):\n" + runtimeText + "\n\nLocked or no-longer-Active integrations are skipped.")) return;
      var summary = { total: scope.targets.length, succeeded: 0, skipped: 0, failed: 0, results: [] };
      bulkState = { phase: "Preparing " + scope.targets.length + " integrations…", complete: false, error: null, current: 0, total: scope.targets.length };
      render();
      for (var index = 0; index < scope.targets.length; index += 1) {
        var target = scope.targets[index];
        bulkState.current = index + 1;
        bulkState.phase = "Applying " + bulkState.current + " of " + bulkState.total + ": " + target.name;
        render();
        var response = await send({ type: "oic:start-bulk-target", target: target, runtimeOptions: runtimeOptions });
        if (!response || !response.ok) {
          summary.failed += 1;
          summary.results.push({ target: target, status: "failed", error: response && response.error && response.error.message || "OIC did not accept the change.", helperTabId: response && response.error && response.error.helperTabId });
          continue;
        }
        var item = response.result || {};
        if (item.status === "skipped-not-active" || item.status === "skipped-busy" || item.status === "skipped-already-configured" || item.status === "skipped-locked") {
          summary.skipped += 1;
          summary.results.push({ target: target, status: item.status, verification: item.verification });
        } else {
          summary.succeeded += 1;
          summary.results.push({ target: target, status: item.status || "active-debug", verification: item.verification });
        }
      }
      bulkState.phase = "Complete: " + summary.succeeded + " updated, " + summary.skipped + " skipped, " + summary.failed + " failed";
      bulkState.complete = true;
      render();
      setTimeout(function () { bulkState = null; render(); }, 5000);
      var failed = (summary.results || []).filter(function (item) { return item.status === "failed"; });
      if (failed.length) {
        var first = failed[0];
        var suffix = failed.length > 1 ? " (and " + (failed.length - 1) + " more failure" + (failed.length === 2 ? "" : "s") + ")" : "";
        showError({ message: "Debug failed for " + first.target.name + ": " + (first.error || "OIC did not accept the change.") + suffix, helperTabId: first.helperTabId });
        refreshIntegrationsAfterBulk();
        return;
      }
      rememberBulkCrossCheck(summary.results);
      showSuccess("Debug activation complete: " + (summary.succeeded || 0) + " updated, " + (summary.skipped || 0) + " skipped, " + (summary.failed || 0) + " failed.");
      refreshIntegrationsAfterBulk();
    } catch (error) {
      bulkState = { phase: "Stopped: " + (error.message || String(error)), complete: true, error: error.message || String(error) };
      render();
      setTimeout(function () { bulkState = null; render(); }, 5000);
      showError({ message: error.message || String(error) });
    }
  }
  function renderBulkControl() {
    var id = "oic-bulk-debug-control";
    var previous = document.getElementById(id);
    // This belongs alongside OIC's Import/Create controls, never as a floating
    // overlay. Hide it whenever OIC has an open sheet, dialog, or menu.
    if (activationSheetVisible() || oicOverlayVisible()) { if (previous) previous.remove(); return; }
    var anchor = bulkAnchor();
    if (!anchor) { if (previous) previous.remove(); return; }
    var loaded = bulkScopeFromLoadedRows();
    var activeTargets = loaded.targets.filter(function (target) { return OicTargets.isActiveStatus(target.status); });
    var busy = bulkState && !bulkState.complete && !bulkState.error;
    var signature = [activeTargets.length, loaded.filters.join("|"), busy, bulkState && bulkState.phase].join("::");
    if (previous && previous.dataset.signature === signature && previous.previousElementSibling === anchor) return;
    if (previous) previous.remove();
    var wrap = document.createElement("section"); wrap.id = id; wrap.className = "oic-bulk-control"; wrap.dataset.signature = signature; wrap.setAttribute("aria-label", "OIC bulk Debug controls");
    if (busy) {
      wrap.appendChild(Object.assign(document.createElement("span"), { className: "oic-bulk-status", textContent: bulkState.phase }));
    } else {
      var label = activeTargets.length ? "Apply Debug Settings to " + activeTargets.length + " Active" : "No Active Integrations";
      var action = button(label, "oic-activate-all", requestBulkOperation, activeTargets.length === 0);
      action.title = loaded.filters.length ? "Applies Debug and saved runtime settings only to Active integrations in the current filters: " + loaded.filters.join(", ") : "Applies Debug and saved runtime settings to all currently Active integrations";
      wrap.appendChild(action);
    }
    // Keep every native OIC header action in place. This merely adds a sibling
    // after Create; it does not wrap, replace, hide, or restyle Create.
    anchor.insertAdjacentElement("afterend", wrap);
  }
  function findFilterTarget() { return OicTargets.findFilteredTarget(document.body && document.body.innerText || ""); }
  function versionParts(value) {
    return String(value || "").split(".").map(function (part) { return String(parseInt(part, 10) || 0); }).join(".");
  }
  function allAttributeText(element) {
    return OicTargets.clean(Array.from(element.attributes || []).map(function (attr) { return attr.value; }).concat([element.textContent]).join(" "));
  }
  function targetFromPrimaryLink(link, filteredTarget) {
    var candidates = Array.from(link.attributes || []).map(function (attr) { return attr.value; }).concat([link.textContent]);
    var parsed = candidates.map(function (candidate) {
      var text = OicTargets.clean(candidate);
      if (/^https?:|^#/.test(text)) return null;
      var match = text.match(/(.+?)\s*\|\s*(\d+(?:\.\d+){1,3})/);
      if (!match) return null;
      return { name: OicTargets.clean(match[1]), version: match[2] };
    }).filter(Boolean).sort(function (left, right) { return right.name.length - left.name.length; })[0];
    if (!parsed) return null;
    if (filteredTarget && versionParts(filteredTarget.version) === versionParts(parsed.version)) {
      var prefix = parsed.name.slice(0, Math.min(18, parsed.name.length));
      if (filteredTarget.name === parsed.name || filteredTarget.name.indexOf(prefix) === 0 || parsed.name.indexOf(filteredTarget.name.slice(0, 18)) === 0) return filteredTarget;
    }
    return { name: parsed.name, code: "", version: parsed.version, key: parsed.name + "|" + parsed.version };
  }
  function primaryIntegrationLinks(filteredTarget) {
    return Array.from(document.querySelectorAll("a")).map(function (link) {
      if (link.offsetParent === null || link.closest("#" + ROOT_ID)) return false;
      var target = targetFromPrimaryLink(link, filteredTarget);
      return target ? { link: link, target: target } : null;
    }).filter(Boolean);
  }
  function renderPrimaryControls(filteredTarget) {
    var validHosts = new Set();
    primaryIntegrationLinks(filteredTarget).forEach(function (entry) {
      var link = entry.link;
      var target = entry.target;
      var host = link.parentElement;
      if (!host) return;
      validHosts.add(host);
      var prior = host.querySelector(":scope > .oic-row-control");
      if (prior && prior.dataset.targetKey === target.key) return;
      if (prior) prior.remove();
      var control = targetControl(target, true);
      control.dataset.targetKey = target.key;
      link.insertAdjacentElement("afterend", control);
    });
    document.querySelectorAll(".oic-row-control, .oic-header-slot").forEach(function (control) {
      if (!validHosts.has(control.parentElement)) control.remove();
    });
  }
  function pageTarget() {
    return OicTargets.findPageTarget(document.body && document.body.innerText || "");
  }
  function exactControl(label) {
    var candidate = Array.from(document.querySelectorAll("button,a,[role=button],oj-button")).find(function (element) {
      return visible(element) && !element.closest("#" + ROOT_ID) && elementText(element).toLowerCase() === label.toLowerCase();
    });
    if (!candidate) return null;
    // Insert beside the full native interactive element, never inside its inner label.
    return candidate.closest("button,a,[role=button],oj-button") || candidate;
  }
  function renderPageControl(target, mode) {
    var anchor = exactControl(mode === "editor" ? "save" : "run");
    var controlId = "oic-" + mode + "-control";
    var previous = document.getElementById(controlId);
    if (!anchor || !target) { if (previous) previous.remove(); return; }
    // OIC's Run action host stacks arbitrary siblings vertically. Mark that host
    // so the injected Edit control and native Run action share one horizontal row.
    if (anchor.parentElement) anchor.parentElement.classList.add("oic-native-action-pair");
    var state = states.get(target.key);
    var busy = state && !state.complete && !state.error;
    if (previous && previous.dataset.targetKey === target.key && previous.dataset.busy === String(!!busy)) return;
    if (previous) previous.remove();
    var wrap = document.createElement("span");
    wrap.id = controlId; wrap.className = "oic-page-control"; wrap.dataset.targetKey = target.key; wrap.dataset.busy = String(!!busy);
    if (busy) wrap.appendChild(Object.assign(document.createElement("span"), { className: "oic-page-status", textContent: state.phase }));
    else if (mode === "editor") wrap.appendChild(button("Save, Activate Debug & Run", "oic-activate-run", function () { requestOperation("activate-debug-run", target); }, false));
    else wrap.appendChild(button("Edit", "oic-edit", function () { requestOperation("edit", target); }, false));
    anchor.insertAdjacentElement("beforebegin", wrap);
  }
  function render() {
    if (!document.body) return;
    if (isIntegrations()) {
      ensureRoot();
      renderBulkControl();
      document.querySelectorAll(".oic-row-control, .oic-page-control").forEach(function (control) { control.remove(); });
      return;
    }
    var bulkControl = document.getElementById("oic-bulk-debug-control"); if (bulkControl) bulkControl.remove();
    if (isInstances()) {
      ensureRoot();
      renderPrimaryControls(findFilterTarget());
      document.querySelectorAll(".oic-page-control").forEach(function (control) { control.remove(); });
      return;
    }
    document.querySelectorAll(".oic-row-control, .oic-header-slot").forEach(function (control) { control.remove(); });
    if (isEditor()) { ensureRoot(); renderPageControl(pageTarget(), "editor"); return; }
    if (isRun()) { ensureRoot(); renderPageControl(pageTarget(), "run"); return; }
    document.querySelectorAll(".oic-page-control").forEach(function (control) { control.remove(); });
  }
  function scheduleRender() { window.requestAnimationFrame(render); }
  observer = new MutationObserver(function (records) {
    var externalChange = records.some(function (record) {
      var changed = Array.from(record.addedNodes).concat(Array.from(record.removedNodes));
      return changed.some(function (node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return record.target.closest ? !record.target.closest("#" + ROOT_ID + ", .oic-row-control") : true;
        return !(node.id === ROOT_ID || node.closest("#" + ROOT_ID + ", .oic-row-control"));
      });
    });
    if (externalChange) scheduleRender();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener("popstate", scheduleRender); window.addEventListener("hashchange", scheduleRender); setInterval(scheduleRender, 1500); render();
  if (isIntegrations()) showRememberedBulkCrossCheck();
})();
