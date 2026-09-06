"use strict";

const cp = require("node:child_process");
const { resolveAgent, runExecutable } = require("./executables");

let cached;
function resolveMuse() {
  if (cached !== undefined) return cached;
  const native = resolveAgent("muse");
  if (native || process.env.PBHANDOVER_MUSE_BIN || process.platform !== "win32") return (cached = native);
  const requested = process.env.PBHANDOVER_WSL_DISTRO;
  const list = requested ? [requested] : String(cp.spawnSync("wsl.exe", ["--list", "--quiet"], {
    encoding: "utf16le", windowsHide: true, timeout: 5000
  }).stdout || "").replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("docker-desktop"));
  for (const distro of list) {
    const probe = cp.spawnSync("wsl.exe", ["--distribution", distro, "--exec", "sh", "-lc",
      'command -v muse || { test -x "$HOME/.local/bin/muse" && printf "%s" "$HOME/.local/bin/muse"; }'], {
      encoding: "utf8", windowsHide: true, timeout: 10000
    });
    const binary = String(probe.stdout || "").trim();
    if (probe.status === 0 && binary.startsWith("/") && !binary.includes("\n")) {
      return (cached = { command: "wsl.exe", args: ["--distribution", distro, "--exec", binary], shell: false, distro });
    }
  }
  return (cached = null);
}

function wslPath(file, distro) {
  if (!distro) return file;
  const result = cp.spawnSync("wsl.exe", ["--distribution", distro, "--exec", "wslpath", "-a", "-u", file], {
    encoding: "utf8", windowsHide: true, timeout: 5000
  });
  if (result.status !== 0) throw new Error("Could not convert path for WSL");
  return result.stdout.trim();
}

function runMuse(args, options = {}) {
  return runExecutable(resolveMuse(), args, options);
}

module.exports = { resolveMuse, wslPath, runMuse };
