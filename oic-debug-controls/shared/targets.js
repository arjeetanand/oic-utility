(function (root) {
  "use strict";

  var ID_PATTERN = /\(([A-Z][A-Z0-9_.$-]*)\s*\|\s*(\d+(?:\.\d+){1,3})\)/;
  var FILTER_PATTERN = /Integration\s+(.+?)\s*\(([A-Z][A-Z0-9_.$-]*)\s*\|\s*(\d+(?:\.\d+){1,3})\)/i;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function makeTarget(name, code, version) {
    if (!code || !version) return null;
    return { name: clean(name) || code, code: code, version: version, key: code + "|" + version };
  }

  function parseIntegrationText(text) {
    var normalized = clean(text);
    var filter = normalized.match(FILTER_PATTERN);
    if (filter) return makeTarget(filter[1], filter[2], filter[3]);
    var id = normalized.match(ID_PATTERN);
    if (!id) return null;
    var name = clean(normalized.slice(0, id.index).replace(/^Integration\s+/i, ""));
    return makeTarget(name, id[1], id[2]);
  }

  function findFilteredTarget(text) {
    var normalized = clean(text);
    var match = normalized.match(FILTER_PATTERN);
    return match ? makeTarget(match[1], match[2], match[3]) : null;
  }

  function findPageTarget(text) {
    var lines = String(text || "").split(/\n+/).map(clean).filter(Boolean);
    for (var index = 0; index < Math.min(lines.length, 45); index += 1) {
      var inline = lines[index].match(/^(.+?)\s*\((\d+(?:\.\d+){1,3})\)$/);
      if (inline && inline[1].length < 150) return { name: inline[1], code: "", version: inline[2], key: inline[1] + "|" + inline[2] };
      var pairedVersion = lines[index + 1] && lines[index + 1].match(/^(\d+(?:\.\d+){1,3})(?:\s+(?:Configured|Active|Draft|Locked))?$/i);
      if (pairedVersion && lines[index].length < 150 && !/^(Oracle|Design|Share|Save|Run)$/i.test(lines[index])) return { name: lines[index], code: "", version: pairedVersion[1], key: lines[index] + "|" + pairedVersion[1] };
    }
    return null;
  }

  function targetFromElement(element) {
    if (!element) return null;
    var candidates = [element.getAttribute && element.getAttribute("title"), element.getAttribute && element.getAttribute("aria-label"), element.textContent];
    for (var i = 0; i < candidates.length; i += 1) {
      var target = parseIntegrationText(candidates[i]);
      if (target) return target;
    }
    return null;
  }

  function isInstancesUrl(url) {
    return /(?:root=monitoringTracking|monitoringTracking|\/instances)/i.test(String(url || ""));
  }

  root.OicTargets = {
    clean: clean,
    makeTarget: makeTarget,
    parseIntegrationText: parseIntegrationText,
    findFilteredTarget: findFilteredTarget,
    findPageTarget: findPageTarget,
    targetFromElement: targetFromElement,
    isInstancesUrl: isInstancesUrl
  };
})(typeof self !== "undefined" ? self : this);
