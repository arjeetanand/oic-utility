/* global chrome */
var DEFAULT_ORIGIN = "https://design.integration.ap-hyderabad-1.ocp.oraclecloud.com";
var defaults = { tracingLevel: "debug", allowRunAgain: true, payloadValidation: false, environments: [DEFAULT_ORIGIN] };
var environments = [];

function normalizeOrigin(value) { try { var url = new URL(String(value || "").trim()); return url.protocol === "https:" && /(^|\.)oraclecloud\.com$/i.test(url.hostname) ? url.origin : null; } catch (_error) { return null; } }
function showStatus(message, error) { var status = document.getElementById("status"); status.textContent = message; status.className = error ? "error" : ""; }
function selectedOptions() { return { allowRunAgain: document.getElementById("allowRunAgain").checked, payloadValidation: document.getElementById("payloadValidation").checked }; }
function optionSummary(options) { return "Allow to run again " + (options.allowRunAgain ? "enabled" : "unchanged") + "; payload validation " + (options.payloadValidation ? "enabled" : "unchanged") + "."; }
function storageGet() {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.get(defaults, function (settings) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(settings);
    });
  });
}
function storageSet(settings) {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.set(settings, function () {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve();
    });
  });
}
function send(message) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(message, function (result) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(result);
    });
  });
}
function renderEnvironments() {
  var list = document.getElementById("environmentList"); list.textContent = "";
  environments.forEach(function (origin) {
    var row = document.createElement("div"); row.className = "environment-row";
    var label = document.createElement("code"); label.textContent = origin; row.appendChild(label);
    var remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-environment"; remove.textContent = "Remove";
    remove.addEventListener("click", function () { environments = environments.filter(function (item) { return item !== origin; }); renderEnvironments(); }); row.appendChild(remove); list.appendChild(row);
  });
}
async function loadSettings() {
  try {
    var settings = await storageGet();
    environments = Array.from(new Set((settings.environments || [DEFAULT_ORIGIN]).map(normalizeOrigin).filter(Boolean)));
    document.getElementById("allowRunAgain").checked = !!settings.allowRunAgain;
    document.getElementById("payloadValidation").checked = !!settings.payloadValidation;
    renderEnvironments();
    showStatus("Loaded: " + optionSummary(selectedOptions()));
  } catch (error) { showStatus("Could not load extension settings: " + error.message, true); }
}
document.getElementById("addEnvironment").addEventListener("click", function () {
  var input = document.getElementById("environmentUrl"); var origin = normalizeOrigin(input.value);
  if (!origin) return showStatus("Enter a valid HTTPS Oracle Cloud URL.", true);
  if (environments.indexOf(origin) === -1) environments.push(origin); input.value = ""; renderEnvironments(); showStatus("Environment added. Click Save settings to grant access.");
});
document.getElementById("save").addEventListener("click", async function () {
  var save = document.getElementById("save");
  if (!environments.length) return showStatus("Keep at least one OIC environment.", true);
  save.disabled = true;
  try {
    var origins = environments.filter(function (origin) { return origin !== DEFAULT_ORIGIN; }).map(function (origin) { return origin + "/*"; });
    var granted = !origins.length || await chrome.permissions.request({ origins: origins });
    if (!granted) throw new Error("Access was not granted; no changes were saved.");
    var selected = selectedOptions();
    await storageSet({ tracingLevel: "debug", allowRunAgain: selected.allowRunAgain, payloadValidation: selected.payloadValidation, environments: environments });
    var saved = await storageGet();
    if (!!saved.allowRunAgain !== selected.allowRunAgain || !!saved.payloadValidation !== selected.payloadValidation) throw new Error("Chrome did not persist the selected runtime settings.");
    var synced = await send({ type: "oic:sync-hosts" });
    if (!synced || !synced.ok) throw new Error("Settings were saved, but OIC controls could not be refreshed. Reload the OIC tab.");
    showStatus("Saved and verified: " + optionSummary(selected));
  } catch (error) { showStatus(error.message || String(error), true); }
  finally { save.disabled = false; }
});
loadSettings();
