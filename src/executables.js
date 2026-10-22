"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

function findExecutable(name, extra = []) {
  const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const candidates = [
    ...extra,
    ...directories.flatMap((dir) => extensions.map((ext) => path.join(dir, name + ext)))
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      if (process.platform === "win32" && /codex\.cmd$/i.test(candidate)) {
        const script = path.join(path.dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js");
        if (fs.existsSync(script)) return { command: process.execPath, args: [script], shell: false };
      }
      if (process.platform === "win32" && /cline\.cmd$/i.test(candidate)) {
        const binary = path.join(path.dirname(candidate), "node_modules", "cline", "node_modules", "@cline", `cli-windows-${process.arch}`, "bin", "cline.exe");
        if (fs.existsSync(binary)) return { command: binary, args: [], shell: false };
      }
      return { command: path.resolve(candidate), args: [], shell: /\.(cmd|bat)$/i.test(candidate) };
    } catch { /* Try the next location. */ }
  }
  return null;
}

function resolveAgent(name) {
  const override = process.env[`PBHANDOVER_${name.toUpperCase()}_BIN`];
  if (override) {
    return findExecutable(override, [override]);
  }
  const extra = [path.join(os.homedir(), ".local", "bin", name + (process.platform === "win32" ? ".exe" : ""))];
  if (name === "cline" && process.platform === "win32" && process.env.APPDATA) {
    extra.push(path.join(process.env.APPDATA, "npm", "cline.cmd"));
  }
  return findExecutable(name, extra);
}

function runExecutable(executable, args, options = {}) {
  if (!executable) return { status: null, error: new Error("Agent executable not found"), stdout: "", stderr: "" };
  // cmd shims need shell quoting even when an argument is supplied as an array.
  const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  const argv = executable.args.concat(args);
  if (executable.shell && [executable.command, ...argv].some((value) => /["%\r\n!&|<>^]/.test(String(value)))) {
    return { status: null, error: new Error("Shell shim arguments contain unsupported shell characters; use a native executable"), stdout: "", stderr: "" };
  }
  return cp.spawnSync(executable.shell ? quote(executable.command) : executable.command,
    executable.shell ? argv.map(quote) : argv,
    { encoding: "utf8", windowsHide: true, ...options, shell: executable.shell });
}

module.exports = { findExecutable, resolveAgent, runExecutable };
