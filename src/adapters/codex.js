"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { PACKAGE_ROOT, WORKER_ENV } = require("../defaults");
const {
  codexHomeDir,
  ensureDir,
  readJson,
  readText,
  writeJson,
  writeText
} = require("../fs-utils");
const { buildSelfCommand } = require("../shell");

const NAME = "codex";
const DEFAULT_MODEL = "gpt-5.3-codex-spark";
const PROJECT_DIR = ".codex";
const HOOKS_FILE = "hooks.json";

function projectHookFile(root) {
  return path.join(root, PROJECT_DIR, HOOKS_FILE);
}

function userHooksFile() {
  return path.join(codexHomeDir(), HOOKS_FILE);
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
  lastMessageFile: "last-codex-message.txt",
  summaryFromStdout: false,

  isConfigured(root) {
    return fs.existsSync(path.join(root, PROJECT_DIR));
  },

  isAvailable() {
    return Boolean(resolveCodexBin());
  },

  hookIgnoreEntry() {
    return `${PROJECT_DIR}/${HOOKS_FILE}`;
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

  async postEnable(root) {
    await trustHooks(root, { quiet: true });
  },

  installRouter(options = {}) {
    const hooksFile = userHooksFile();
    ensureDir(path.dirname(hooksFile));
    const data = readJson(hooksFile, { hooks: {} });
    data.hooks = data.hooks || {};
    const promptHooks = Array.isArray(data.hooks.UserPromptSubmit) ? data.hooks.UserPromptSubmit : [];
    const filtered = promptHooks.filter((group) => !groupMatches(group, isRouterHandler));
    filtered.push({
      hooks: [
        {
          type: "command",
          command: buildSelfCommand(["prompt-router", "--agent", NAME]),
          timeout: 10,
          statusMessage: "Checking pbhandover command"
        }
      ]
    });
    data.hooks.UserPromptSubmit = filtered;
    writeJson(hooksFile, data);
    if (!options.quiet) {
      console.log(`[codex] command router: installed (${hooksFile})`);
    }
  },

  uninstallRouter() {
    const hooksFile = userHooksFile();
    const data = readJson(hooksFile, { hooks: {} });
    data.hooks = data.hooks || {};
    const promptHooks = Array.isArray(data.hooks.UserPromptSubmit) ? data.hooks.UserPromptSubmit : [];
    const filtered = promptHooks.filter((group) => !groupMatches(group, isRouterHandler));
    if (filtered.length > 0) data.hooks.UserPromptSubmit = filtered;
    else delete data.hooks.UserPromptSubmit;
    writeJson(hooksFile, data);
  },

  routerInstalled() {
    const data = readJson(userHooksFile(), { hooks: {} });
    const promptHooks = data && data.hooks && Array.isArray(data.hooks.UserPromptSubmit)
      ? data.hooks.UserPromptSubmit
      : [];
    return promptHooks.some((group) => groupMatches(group, isRouterHandler));
  },

  routerStatusLines() {
    return [
      `[codex] user hooks: ${userHooksFile()}`,
      `[codex] router installed: ${this.routerInstalled()}`
    ];
  },

  runSummarizer({ root, model, prompt, outFile, timeout }) {
    const codex = resolveCodexBin() || { command: "codex", args: [], shell: false };
    return childProcess.spawnSync(codex.command, codex.args.concat([
      "--disable",
      "hooks",
      "--model",
      model,
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--cd",
      root,
      "--output-last-message",
      outFile,
      "-"
    ]), {
      cwd: root,
      input: prompt,
      encoding: "utf8",
      env: { ...process.env, [WORKER_ENV]: "1" },
      shell: codex.shell,
      windowsHide: true,
      timeout,
      maxBuffer: 10 * 1024 * 1024
    });
  },

  formatRouterResponse(display, reason) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [
          `${display} was handled locally by pbhandover.`,
          "Do not treat the original @handover prompt as a normal user request.",
          "Reply only with a concise summary of this command result:",
          reason
        ].join("\n")
      }
    });
  },

  trust(root) {
    return trustHooks(root, { quiet: false });
  }
};

function setStopHook(hooksFile, enabled) {
  ensureDir(path.dirname(hooksFile));
  const data = readJson(hooksFile, { hooks: {} });
  data.hooks = data.hooks || {};
  const stop = Array.isArray(data.hooks.Stop) ? data.hooks.Stop : [];
  const filtered = stop.filter((group) => !groupMatches(group, isEnqueueHandler));

  if (enabled) {
    filtered.push({
      hooks: [
        {
          type: "command",
          command: buildSelfCommand(["enqueue", "--agent", NAME]),
          timeout: 5,
          statusMessage: "Queueing HANDOVER.md update"
        }
      ]
    });
  }

  if (filtered.length > 0) data.hooks.Stop = filtered;
  else delete data.hooks.Stop;
  writeJson(hooksFile, data);
}

async function trustHooks(cwd, options = {}) {
  const hooks = await listCodexHooks(cwd).catch((error) => {
    if (!options.quiet) console.warn(`[codex] could not inspect hooks for trust: ${error.message}`);
    return [];
  });
  const ownHooks = hooks.filter((hook) => {
    const command = String(hook.command || "");
    return command.includes("pbhandover") && hook.key && hook.currentHash;
  });
  if (ownHooks.length === 0) {
    if (!options.quiet) console.warn("[codex] no pbhandover hooks found to trust.");
    return;
  }
  upsertHookTrust(ownHooks);
  if (!options.quiet) {
    console.log(`[codex] hook trust: updated (${ownHooks.length} entr${ownHooks.length === 1 ? "y" : "ies"})`);
  }
}

function listCodexHooks(cwd) {
  return new Promise((resolve, reject) => {
    const codex = resolveCodexBin() || { command: "codex", args: [], shell: false };
    const child = childProcess.spawn(codex.command, codex.args.concat(["app-server", "--listen", "stdio://"]), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: codex.shell,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Timed out waiting for Codex app-server hooks/list."));
    }, 10000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let lines = stdout.split(/\r?\n/);
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 0) {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 1, method: "hooks/list", params: { cwds: [cwd] } })}\n`);
        } else if (message.id === 1) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          const data = message.result && Array.isArray(message.result.data) ? message.result.data : [];
          const hooks = data.flatMap((entry) => Array.isArray(entry.hooks) ? entry.hooks : []);
          resolve(hooks);
        }
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(stderr.trim() || "Codex app-server exited before hooks/list completed."));
    });

    child.stdin.write(`${JSON.stringify({
      id: 0,
      method: "initialize",
      params: {
        clientInfo: {
          name: "pbhandover",
          title: "pbhandover",
          version: readJson(path.join(PACKAGE_ROOT, "package.json"), { version: "0.0.0" }).version
        },
        capabilities: { experimentalApi: true }
      }
    })}\n`);
  });
}

function upsertHookTrust(hooks) {
  const configFile = path.join(codexHomeDir(), "config.toml");
  let text = readText(configFile, "");
  for (const hook of hooks) {
    const key = tomlSingleQuotedKey(String(hook.key));
    const sectionPattern = new RegExp(`\\n?\\[hooks\\.state\\.${escapeRegExp(key)}\\]\\n(?:[^\\[]|\\[(?!hooks\\.state\\.))*`, "g");
    const section = `[hooks.state.${key}]\ntrusted_hash = "${hook.currentHash}"\nenabled = true\n\n`;
    if (sectionPattern.test(text)) {
      text = text.replace(sectionPattern, `\n${section}`);
    } else {
      if (!/\[hooks\.state\]/.test(text)) {
        text = `${text.replace(/\s*$/, "")}\n\n[hooks.state]\n`;
      }
      text = `${text.replace(/\s*$/, "")}\n\n${section}`;
    }
  }
  writeText(configFile, text);
}

function tomlSingleQuotedKey(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveCodexBin() {
  const override = process.env.PBHANDOVER_CODEX_BIN;
  if (override) return { command: override, args: [], shell: process.platform === "win32" };
  if (process.platform === "win32") {
    const cmd = path.join(process.env.APPDATA || "", "npm", "codex.cmd");
    if (fs.existsSync(cmd)) return { command: cmd, args: [], shell: true };
    return { command: "codex", args: [], shell: true };
  }
  return { command: "codex", args: [], shell: false };
}
