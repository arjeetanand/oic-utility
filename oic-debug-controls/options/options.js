/* global chrome */
var defaults = { tracingLevel: "debug", allowRunAgain: true, payloadValidation: false };
chrome.storage.local.get(defaults, function (settings) { document.getElementById("tracingLevel").value = settings.tracingLevel; document.getElementById("allowRunAgain").checked = settings.allowRunAgain; document.getElementById("payloadValidation").checked = settings.payloadValidation; });
document.getElementById("save").addEventListener("click", function () { chrome.storage.local.set({ tracingLevel: document.getElementById("tracingLevel").value, allowRunAgain: document.getElementById("allowRunAgain").checked, payloadValidation: document.getElementById("payloadValidation").checked }, function () { document.getElementById("status").textContent = "Saved."; }); });
