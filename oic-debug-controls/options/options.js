/* global chrome */
var DEFAULT_ORIGIN = "https://design.integration.ap-hyderabad-1.ocp.oraclecloud.com";
var defaults = { tracingLevel: "debug", allowRunAgain: true, payloadValidation: false, environments: [DEFAULT_ORIGIN] };
var environments = [];
function normalizeOrigin(value) { try { var url = new URL(String(value || "").trim()); return url.protocol === "https:" && /(^|\.)oraclecloud\.com$/i.test(url.hostname) ? url.origin : null; } catch (_error) { return null; } }
function renderEnvironments() {
  var list = document.getElementById("environmentList"); list.textContent = "";
  environments.forEach(function (origin) {
    var row = document.createElement("div"); row.className = "environment-row";
    var label = document.createElement("code"); label.textContent = origin; row.appendChild(label);
    var remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-environment"; remove.textContent = "Remove";
    remove.addEventListener("click", function () { environments = environments.filter(function (item) { return item !== origin; }); renderEnvironments(); }); row.appendChild(remove); list.appendChild(row);
  });
}
function showStatus(message, error) { var status = document.getElementById("status"); status.textContent = message; status.className = error ? "error" : ""; }
chrome.storage.local.get(defaults, function (settings) { environments = Array.from(new Set((settings.environments || []).map(normalizeOrigin).filter(Boolean))); document.getElementById("tracingLevel").value = settings.tracingLevel; document.getElementById("allowRunAgain").checked = settings.allowRunAgain; document.getElementById("payloadValidation").checked = settings.payloadValidation; renderEnvironments(); });
document.getElementById("addEnvironment").addEventListener("click", function () {
  var input = document.getElementById("environmentUrl"); var origin = normalizeOrigin(input.value);
  if (!origin) return showStatus("Enter a valid HTTPS Oracle Cloud URL.", true);
  if (environments.indexOf(origin) === -1) environments.push(origin); input.value = ""; renderEnvironments(); showStatus("Environment added. Click Save settings to grant access.");
});
document.getElementById("save").addEventListener("click", async function () {
  if (!environments.length) return showStatus("Keep at least one OIC environment.", true);
  // The default host is a required permission. Only newly added environments
  // need a runtime permission prompt.
  var origins = environments.filter(function (origin) { return origin !== DEFAULT_ORIGIN; }).map(function (origin) { return origin + "/*"; });
  var granted = !origins.length || await chrome.permissions.request({ origins: origins });
  if (!granted) return showStatus("Access was not granted; no changes were saved.", true);
  chrome.storage.local.set({ tracingLevel: document.getElementById("tracingLevel").value, allowRunAgain: document.getElementById("allowRunAgain").checked, payloadValidation: document.getElementById("payloadValidation").checked, environments: environments }, function () {
    chrome.runtime.sendMessage({ type: "oic:sync-hosts" }, function (result) { showStatus(result && result.ok ? "Saved. Controls are available in your open OIC tabs now." : "Saved, but reload the extension if the controls do not appear.", !(result && result.ok)); });
  });
});
