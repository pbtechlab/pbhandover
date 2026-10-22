"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PACKAGE_ROOT, WORKER_ENV, TOOL_DIR } = require("../defaults");
const { ensureDir, userConfigDir, writeJson, readJson, writeText } = require("../fs-utils");
const { resolveMuse, runMuse, wslPath } = require("../wsl");

const PLUGIN_ID = "pbhandover";
const pluginRoot = () => path.join(userConfigDir(), "muse-plugin");
const manifestFile = () => path.join(pluginRoot(), ".muse-plugin", "plugin.json");

function checked(args, options = {}) {
  const result = runMuse(args, { timeout: 30000, ...options });
  if (result.error || result.status !== 0) throw new Error(`Muse Code ${args.slice(0, 2).join(" ")}: ${result.error?.message || result.stderr || result.stdout}`);
  return result;
}

function installRouter(options = {}) {
  const executable = resolveMuse();
  if (!executable) throw new Error("Muse Code executable not found (install muse, or select WSL with PBHANDOVER_WSL_DISTRO)");
  const dir = pluginRoot();
  ensureDir(dir);
  const entry = path.join(PACKAGE_ROOT, "bin", "pbhandover.js");
  const hooks = [];
  for (const [id, event, command] of [["stop", "Stop", "enqueue"], ["prompt", "UserPromptSubmit", "prompt-router"]]) {
    let argv;
    if (executable.distro) {
      const script = `${id}.py`;
      writeText(path.join(dir, script), `from bridge import main\nmain(${JSON.stringify(command)})\n`);
      argv = ["python3", "-B", "-c", `import os,sys,runpy; p=os.environ['MUSE_PLUGIN_ROOT']; sys.path.insert(0,p); runpy.run_path(os.path.join(p,${JSON.stringify(script)}),run_name='__main__')`];
    } else {
      const script = `${id}.js`;
      writeText(path.join(dir, script), `"use strict";\nconst cp = require("node:child_process");\nconst fs = require("node:fs");\nconst config = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "bridge.json"), "utf8"));\nconst result = cp.spawnSync(config.node, [config.entry, ${JSON.stringify(command)}, "--agent", "muse"], { input: fs.readFileSync(0), encoding: "utf8", windowsHide: true });\nprocess.stdout.write(result.stdout || "");\nprocess.stderr.write(result.stderr || "");\nprocess.exitCode = result.status ?? 1;\n`);
      argv = [process.execPath, "-e", `require(require('node:path').join(process.env.MUSE_PLUGIN_ROOT, ${JSON.stringify(script)}))`];
    }
    hooks.push({ id, event, command: argv, timeoutMs: id === "stop" ? 10000 : 65000, statusMessage: id === "stop" ? "Queueing handover update" : "Checking handover command" });
  }
  if (executable.distro) {
    fs.copyFileSync(path.join(PACKAGE_ROOT, "src", "muse-bridge.py"), path.join(dir, "bridge.py"));
  }
  writeJson(path.join(dir, "bridge.json"), {
    node: wslPath(process.execPath, executable.distro), entry, distro: executable.distro || null
  });
  writeJson(manifestFile(), {
    schemaVersion: 1, name: PLUGIN_ID, displayName: "pbhandover",
    version: readJson(path.join(PACKAGE_ROOT, "package.json"), {}).version,
    description: "Keep a shared project handover current.",
    compat: { source: "native", manifestDir: ".muse-plugin" },
    capabilities: { skills: [], commands: [], hooks, mcpServers: [], reminders: [] }
  });
  const target = wslPath(dir, executable.distro);
  const validation = JSON.parse(checked(["plugins", "validate", target, "--json"]).stdout);
  if (!validation.valid || validation.diagnostics?.length) throw new Error(`Muse plugin validation failed: ${JSON.stringify(validation.diagnostics)}`);
  checked(["plugins", "install", target, "--scope", "user", "--json"]);
  checked(["plugins", "approve", PLUGIN_ID, "--json"]);
  if (!options.quiet) console.log(`[muse] command router and Stop hook: installed${executable.distro ? ` (WSL: ${executable.distro})` : ""}`);
}

module.exports = {
  name: "muse", defaultModel: null, lastMessageFile: "last-muse-message.txt", summaryFromStdout: true,
  isConfigured(root) { return fs.existsSync(path.join(root, ".muse")); },
  isAvailable() { return Boolean(resolveMuse()); },
  hookIgnoreEntry() { return ".muse/"; },
  projectHookFileStatus() { return { path: manifestFile(), exists: fs.existsSync(manifestFile()) }; },
  enableStopHook() { if (!this.routerInstalled()) installRouter({ quiet: true }); },
  disableStopHook() { /* Per-project enabled state gates the shared Stop hook. */ },
  installRouter,
  uninstallRouter() { checked(["plugins", "remove", PLUGIN_ID, "--json"]); },
  routerInstalled() {
    if (!resolveMuse()) return false;
    try {
      const data = JSON.parse(checked(["plugins", "list", "--json"]).stdout);
      return (data.plugins || []).some((item) => {
        const plugin = item.plugin || item;
        return (plugin.id || plugin.name) === PLUGIN_ID &&
          (item.record?.enabled ?? item.enabled) !== false && item.active !== false;
      });
    } catch { return false; }
  },
  routerStatusLines() { return [`[muse] plugin: ${manifestFile()}`, `[muse] router installed: ${this.routerInstalled()}`]; },
  runSummarizer({ root, model, prompt, timeout }) {
    const executable = resolveMuse();
    if (!executable) return { status: null, error: new Error("Muse Code executable not found") };
    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(root, TOOL_DIR, "worker-sessions");
    ensureDir(sessionDir);
    // Muse hooks use a filtered environment. Persist the session guard before
    // launch so recursion prevention does not depend on inherited variables.
    writeJson(path.join(sessionDir, `${sessionId}.json`), { agent: "muse", createdAt: new Date().toISOString() });
    const translatedRoot = wslPath(root, executable.distro);
    const promptFile = path.join(root, TOOL_DIR, "muse-prompt.md");
    writeText(promptFile, executable.distro ? prompt.split(root).join(translatedRoot).split("\\HANDOVER.md").join("/HANDOVER.md") : prompt);
    const args = ["exec", "--workspace", translatedRoot, "--prompt-file", wslPath(promptFile, executable.distro),
      "--session-id", sessionId, "--approval-mode", "never", "--no-foreign-personal-context", "--disable-web-tools"];
    if (model) args.push("--model", model);
    return runMuse(args, { cwd: root, timeout, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, [WORKER_ENV]: "1" } });
  },
  formatRouterResponse(display, reason) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [
          `${display} was handled locally by pbhandover.`,
          "Do not execute the original @handover command again or treat it as a new task.",
          "Reply only with a concise summary of this command result:",
          reason
        ].join("\n")
      }
    });
  }
};
