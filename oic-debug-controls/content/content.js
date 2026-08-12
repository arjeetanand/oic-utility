/* global chrome, OicTargets */
(function () {
  "use strict";
  var ROOT_ID = "oic-debug-controls-root";
  var states = new Map();
  var observer;

  chrome.runtime.onMessage.addListener(function (message) {
    if (message.type === "oic:state") { states.set(message.key, message.state); render(); }
  });

  function send(message) { return new Promise(function (resolve) { chrome.runtime.sendMessage(message, resolve); }); }
  function currentUrl() { return window.location.href; }
  // A toast on the Integrations list says "go to Instances", so checking page text
  // incorrectly mounted an Edit button beside every integration name. Route is the
  // authoritative signal for this view.
  function isInstances() { return OicTargets.isInstancesUrl(currentUrl()); }
  function isEditor() { return /root=integration(?:&|$)/i.test(currentUrl()) && !/root=integrations(?:&|$)/i.test(currentUrl()); }
  function isRun() { return /root=invokeIntegration(?:&|$)/i.test(currentUrl()); }
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
    if (operation === "activate-debug-run" && !window.confirm("Save changes, activate " + target.name + " (" + target.version + ") with Debug tracing, then open its Run page?\n\nIf OIC reports it as Locked, this will unlock that exact integration first. OIC warns that unlocking can cause data loss. Debug tracing is reset by Oracle after 24 hours.")) return;
    var result = await send({ type: "oic:start", operation: operation, target: target });
    if (!result || !result.ok) showError((result && result.error) || { message: "Could not start OIC automation." });
  }
  function showError(error) {
    var toast = document.createElement("div"); toast.className = "oic-toast oic-toast-error"; toast.textContent = error.message;
    if (error.helperTabId) { var open = button("Open helper tab", "oic-open-helper", function () { chrome.runtime.sendMessage({ type: "oic:open-helper", tabId: error.helperTabId }); toast.remove(); }); toast.appendChild(open); }
    ensureRoot().appendChild(toast); setTimeout(function () { toast.remove(); }, 16000);
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
})();
