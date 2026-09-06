"use strict";

// Preserve unrelated handlers, including those sharing a matcher group.
function removeHandlers(groups, predicate) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    ...group, hooks: (Array.isArray(group.hooks) ? group.hooks : []).filter((hook) => !predicate(hook))
  })).filter((group) => group.hooks.length > 0);
}

function upsertTrust(text, hooks) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const keys = new Set(hooks.map((hook) => String(hook.key)));
  const lines = text.split(/\r?\n/);
  let skip = false;
  const kept = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      skip = false;
      const match = line.match(/^\s*\[hooks\.state\.(.+)\]\s*(?:#.*)?$/);
      if (match) {
        let key;
        try { key = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].replace(/^'|'$/g, ""); } catch { key = null; }
        skip = keys.has(key);
      }
    }
    if (!skip) kept.push(line);
  }
  const sections = hooks.map((hook) => `[hooks.state.${JSON.stringify(String(hook.key))}]${newline}trusted_hash = ${JSON.stringify(String(hook.currentHash))}${newline}enabled = true`);
  return kept.join(newline).trimEnd() + newline + newline + sections.join(newline + newline) + newline;
}

module.exports = { removeHandlers, upsertTrust };
