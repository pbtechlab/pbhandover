"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { PACKAGE_ROOT, COMMANDS_DIR, SLASH_COMMAND_FILE, WORKER_ENV } = require("../defaults");
const {
  claudeHomeDir,
  ensureDir,
  readJson,
  readText,
  writeJson,
  writeText
} = require("../fs-utils");
const { buildSelfCommand } = require("../shell");

const NAME = "claude";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const PROJECT_DIR = ".claude";
const PROJECT_SETTINGS_FILE = "settings.local.json";
const USER_SETTINGS_FILE = "settings.json";

function projectHookFile(root) {
  return path.join(root, PROJECT_DIR, PROJECT_SETTINGS_FILE);
}

function userSettingsFile() {
  return path.join(claudeHomeDir(), USER_SETTINGS_FILE);
}

function slashCommandFile() {
  return path.join(claudeHomeDir(), COMMANDS_DIR, SLASH_COMMAND_FILE);
}

function isEnqueueHandler(handler) {
  const command = String(handler.command || "");
  return command.includes("pbhandover") && command.includes("enqueue");
}

function isRouterHandler(handler) {
  const command = String(handler.command || "");
  return command.includes("pbhandover") && command.includes("prompt-router");
}

function groupMatches(group, predicate) {
  const handlers = Array.isArray(group.hooks) ? group.hooks : [];
  return handlers.some(predicate);
}

module.exports = {
  name: NAME,
  defaultModel: DEFAULT_MODEL,
  lastMessageFile: "last-claude-message.txt",
  summaryFromStdout: true,

  isConfigured(root) {
    return fs.existsSync(path.join(root, PROJECT_DIR));
  },

  isAvailable() {
    return Boolean(resolveClaudeBin());
  },

  hookIgnoreEntry() {
    return `${PROJECT_DIR}/${PROJECT_SETTINGS_FILE}`;
  },

  projectHookFileStatus(root) {
    const file = projectHookFile(root);
    return { path: file, exists: fs.existsSync(file) };
  },

  enableStopHook(root) {
    setStopHook(projectHookFile(root), true);
  },

  disableStopHook(root) {
    setStopHook(projectHookFile(root), false);
  },

  installRouter(options = {}) {
    const settingsFile = userSettingsFile();
    ensureDir(path.dirname(settingsFile));
    const data = readJson(settingsFile, {});
    data.hooks = data.hooks || {};
    const promptHooks = Array.isArray(data.hooks.UserPromptSubmit) ? data.hooks.UserPromptSubmit : [];
    const filtered = promptHooks.filter((group) => !groupMatches(group, isRouterHandler));
    filtered.push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: buildSelfCommand(["prompt-router", "--agent", NAME]),
          timeout: 10
        }
      ]
    });
    data.hooks.UserPromptSubmit = filtered;
    writeJson(settingsFile, data);
    installSlashCommand();
    if (!options.quiet) {
      console.log(`[claude] command router: installed (${settingsFile})`);
      console.log(`[claude] slash command: ${slashCommandFile()}`);
    }
  },

  uninstallRouter() {
    const settingsFile = userSettingsFile();
    const data = readJson(settingsFile, {});
    data.hooks = data.hooks || {};
    const promptHooks = Array.isArray(data.hooks.UserPromptSubmit) ? data.hooks.UserPromptSubmit : [];
    const filtered = promptHooks.filter((group) => !groupMatches(group, isRouterHandler));
    if (filtered.length > 0) data.hooks.UserPromptSubmit = filtered;
    else delete data.hooks.UserPromptSubmit;
    if (data.hooks && Object.keys(data.hooks).length === 0) delete data.hooks;
    writeJson(settingsFile, data);
    try {
      const slash = slashCommandFile();
      if (fs.existsSync(slash)) fs.unlinkSync(slash);
    } catch {
      // Slash command cleanup is best effort.
    }
  },

  routerInstalled() {
    const data = readJson(userSettingsFile(), {});
    const promptHooks = data && data.hooks && Array.isArray(data.hooks.UserPromptSubmit)
      ? data.hooks.UserPromptSubmit
      : [];
    return promptHooks.some((group) => groupMatches(group, isRouterHandler));
  },

  routerStatusLines() {
    const slash = slashCommandFile();
    return [
      `[claude] user settings: ${userSettingsFile()}`,
      `[claude] router installed: ${this.routerInstalled()}`,
      `[claude] slash command: ${slash} (${fs.existsSync(slash) ? "installed" : "missing"})`
    ];
  },

  runSummarizer({ root, model, prompt, timeout }) {
    const claude = resolveClaudeBin() || { command: "claude", args: [], shell: process.platform === "win32" };
    return childProcess.spawnSync(claude.command, claude.args.concat([
      "-p",
      "--model",
      model,
      "--dangerously-skip-permissions",
      "--output-format",
      "text"
    ]), {
      cwd: root,
      input: prompt,
      encoding: "utf8",
      env: { ...process.env, [WORKER_ENV]: "1" },
      shell: claude.shell,
      windowsHide: true,
      timeout,
      maxBuffer: 10 * 1024 * 1024
    });
  },

  formatRouterResponse(display, reason) {
    return JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit" }
    });
  }
};

function setStopHook(settingsFile, enabled) {
  ensureDir(path.dirname(settingsFile));
  // Preserve all non-hook keys in the personal settings file.
  const data = readJson(settingsFile, {});
  data.hooks = data.hooks || {};
  const stop = Array.isArray(data.hooks.Stop) ? data.hooks.Stop : [];
  const filtered = stop.filter((group) => !groupMatches(group, isEnqueueHandler));

  if (enabled) {
    filtered.push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: buildSelfCommand(["enqueue", "--agent", NAME]),
          timeout: 5
        }
      ]
    });
  }

  if (filtered.length > 0) data.hooks.Stop = filtered;
  else delete data.hooks.Stop;
  if (data.hooks && Object.keys(data.hooks).length === 0) delete data.hooks;
  writeJson(settingsFile, data);
}

function installSlashCommand() {
  const target = slashCommandFile();
  ensureDir(path.dirname(target));
  const body = readText(path.join(PACKAGE_ROOT, COMMANDS_DIR, SLASH_COMMAND_FILE), "");
  if (body) writeText(target, body);
}

function resolveClaudeBin() {
  const override = process.env.PBHANDOVER_CLAUDE_BIN;
  if (override) return { command: override, args: [], shell: process.platform === "win32" };
  if (process.platform === "win32") {
    for (const candidate of [
      path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe")
    ]) {
      if (candidate && fs.existsSync(candidate)) return { command: candidate, args: [], shell: true };
    }
    return { command: "claude", args: [], shell: true };
  }
  return { command: "claude", args: [], shell: false };
}
