"use strict";

const path = require("node:path");
const { PACKAGE_ROOT } = require("./defaults");

// Claude Code and Codex run hook command strings through a shell. On Windows
// that shell (bash/sh under Git Bash, or cmd) treats "\" as an escape, so we
// emit the script path with forward slashes — Node accepts them on Windows.
function buildSelfCommand(args) {
  const binPath = path.join(PACKAGE_ROOT, "bin", "pbhandover.js");
  if (process.platform === "win32") {
    const parts = ["node", binPath.replace(/\\/g, "/"), ...args];
    return parts.map(cmdCompatibleQuoteArg).join(" ");
  }
  const parts = [process.execPath, binPath, ...args];
  return parts.map(shQuoteArg).join(" ");
}

function cmdCompatibleQuoteArg(value) {
  if (!/\s/.test(String(value))) return String(value);
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function shQuoteArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function psSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = {
  buildSelfCommand,
  cmdCompatibleQuoteArg,
  psSingleQuoted,
  shQuoteArg
};
