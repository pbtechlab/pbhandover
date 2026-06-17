"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  AGENTS,
  CLI_NAME,
  HANDOVER_FILE,
  NO_WORKER_ENV,
  PACKAGE_ROOT,
  TOOL_DIR,
  WORKER_ENV
} = require("./defaults");
const {
  atomicWrite,
  cleanupTempFiles,
  copyFileIfMissing,
  ensureDir,
  readJson,
  readText,
  safeFileStamp,
  timestamp,
  userConfigDir,
  writeJson,
  writeText
} = require("./fs-utils");
const { getAdapter, allAdapters } = require("./adapters");
const { psSingleQuoted } = require("./shell");

const DEFAULT_TEMPLATE = path.join(PACKAGE_ROOT, "templates", "default-template.md");
const DEFAULT_PROMPT = path.join(PACKAGE_ROOT, "prompts", "default-prompt.md");

async function main(argv) {
  const command = argv[0] && (!argv[0].startsWith("-") || ["--help", "-h", "--version", "-V"].includes(argv[0]))
    ? argv[0]
    : "help";
  const args = command === "help" ? argv : argv.slice(1);

  switch (command) {
    case "setup":
      return setup(args);
    case "on":
      return on(args);
    case "off":
      return off(args);
    case "status":
    case "doctor":
      return status();
    case "enqueue":
      return enqueue(args);
    case "prompt-router":
      return promptRouter(args);
    case "router":
      return router(args);
    case "trust":
      return trust(args);
    case "worker":
      return worker(args);
    case "flush":
      return worker(["--foreground", ...args]);
    case "template":
      return template(args);
    case "help":
    case "--help":
    case "-h":
      return help();
    case "--version":
    case "-V":
      return version();
    default:
      throw new Error(`Unknown command: ${command}\nRun "${CLI_NAME} --help" for usage.`);
  }
}

function help() {
  console.log(`${CLI_NAME} — shared HANDOVER.md for Claude Code and Codex CLI

Usage:
  ${CLI_NAME} setup [--force] [--no-router]
  ${CLI_NAME} on [--claude] [--codex] [--track-handover] [--track-hooks] [--force-template]
  ${CLI_NAME} off [--claude] [--codex]
  ${CLI_NAME} status
  ${CLI_NAME} router install|uninstall|status [--claude] [--codex]
  ${CLI_NAME} trust
  ${CLI_NAME} enqueue --agent claude|codex
  ${CLI_NAME} worker
  ${CLI_NAME} flush
  ${CLI_NAME} template path|sync [--force]

Commands:
  setup      Create the shared user template, prompt, config and command router.
  on         Enable the Stop hook in the current project (auto-detects claude/codex).
  off        Disable this tool's Stop hook in the current project.
  status     Show project, per-agent and queue status.
  router     Install or remove the @handover command router (and /handover slash).
  trust      Trust this tool's installed Codex hooks.
  enqueue    Fast hook entrypoint. Writes one queued turn and returns.
  worker     Process queued turns sequentially in the background.
  flush      Process queued turns in the foreground and wait.
  template   Show or sync template files.

Inside an agent session: @handover on | @handover off | @handover status | @handover flush
(Claude Code also accepts the /handover slash command.)
`);
}

function version() {
  const pkg = readJson(path.join(PACKAGE_ROOT, "package.json"), { version: "0.0.0" });
  console.log(pkg.version);
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function setup(args) {
  const force = args.includes("--force");
  const quiet = args.includes("--quiet");
  const noRouter = args.includes("--no-router");
  const dir = userConfigDir();
  ensureDir(dir);
  const templatePath = path.join(dir, "template.md");
  const promptPath = path.join(dir, "prompt.md");
  const configPath = path.join(dir, "config.json");

  const templateCreated = copyFileIfMissing(DEFAULT_TEMPLATE, templatePath, force);
  const promptCreated = copyFileIfMissing(DEFAULT_PROMPT, promptPath, force);
  if (force || !fs.existsSync(configPath)) {
    writeJson(configPath, {
      queueMode: "sequential",
      handoverFile: HANDOVER_FILE,
      redactSecrets: true,
      agents: defaultAgentsConfig()
    });
  }

  if (!quiet) {
    console.log(`${CLI_NAME}: setup completed`);
    console.log(`Shared template: ${templatePath} (${templateCreated ? "created" : "kept"})`);
    console.log(`Shared prompt: ${promptPath} (${promptCreated ? "created" : "kept"})`);
  }

  if (!noRouter) {
    for (const adapter of allAdapters()) {
      if (adapter.isAvailable()) adapter.installRouter({ quiet });
    }
  }
}

// ---------------------------------------------------------------------------
// on / off
// ---------------------------------------------------------------------------

async function on(args) {
  await setup(["--quiet"]);
  const root = process.cwd();
  const project = projectPaths(root);
  const trackHandover = args.includes("--track-handover");
  const trackHooks = args.includes("--track-hooks");
  const forceTemplate = args.includes("--force-template");
  const selected = resolveAgentsForOn(args, root);

  ensureDir(project.toolDir);
  ensureDir(project.queueDir);
  ensureDir(project.doneDir);
  ensureDir(project.failedDir);

  const userDir = userConfigDir();
  copyFileIfMissing(path.join(userDir, "template.md"), project.templateFile, forceTemplate);
  copyFileIfMissing(path.join(userDir, "prompt.md"), project.promptFile, forceTemplate);

  const config = readJson(project.configFile, null) || {
    enabled: true,
    queueMode: "sequential",
    handoverFile: HANDOVER_FILE,
    templateFile: `${TOOL_DIR}/template.md`,
    promptFile: `${TOOL_DIR}/prompt.md`,
    agents: {}
  };
  config.enabled = true;
  config.trackHandover = Boolean(trackHandover);
  config.trackHooks = Boolean(trackHooks);
  config.agents = config.agents || {};
  for (const name of selected) {
    const adapter = getAdapter(name);
    const existing = config.agents[name] || {};
    config.agents[name] = {
      enabled: true,
      model: existing.model || adapter.defaultModel
    };
  }
  writeJson(project.configFile, config);

  const handoverCreated = !fs.existsSync(project.handoverFile);
  if (handoverCreated) {
    writeText(project.handoverFile, readText(project.templateFile, readText(DEFAULT_TEMPLATE)));
  }

  for (const name of selected) {
    const adapter = getAdapter(name);
    adapter.enableStopHook(root);
    if (typeof adapter.postEnable === "function") {
      await adapter.postEnable(root);
    }
  }

  updateGitignore(root, { trackHandover, trackHooks, agents: selected });

  console.log(`${CLI_NAME}: ON`);
  console.log(`Project: ${root}`);
  console.log(`Agents: ${selected.join(", ")}`);
  console.log(`Handover: ${project.handoverFile} (${handoverCreated ? "created" : "exists"})`);
  console.log(`Template: ${project.templateFile}`);
  console.log(`Queue: ${project.queueDir}`);
  for (const name of selected) {
    const adapter = getAdapter(name);
    const hook = adapter.projectHookFileStatus(root);
    console.log(`[${name}] Stop hook file: ${hook.path}`);
  }
  console.log(`Use inside a session: @handover off | @handover status | @handover flush`);
}

function off(args) {
  const root = findProjectRoot(process.cwd());
  const project = projectPaths(root);
  const config = readJson(project.configFile, {});
  config.agents = config.agents || {};
  const requested = parseAgentFlags(args);
  const selected = requested || Object.keys(config.agents);
  const targets = selected.length ? selected : AGENTS;

  for (const name of targets) {
    const adapter = getAdapter(name);
    adapter.disableStopHook(root);
    if (config.agents[name]) config.agents[name].enabled = false;
  }
  const anyEnabled = Object.values(config.agents).some((entry) => entry && entry.enabled === true);
  config.enabled = anyEnabled;
  writeJson(project.configFile, config);

  console.log(`${CLI_NAME}: OFF`);
  console.log(`Project: ${root}`);
  console.log(`Disabled agents: ${targets.join(", ")}`);
  console.log(`Still enabled: ${anyEnabled ? Object.keys(config.agents).filter((n) => config.agents[n].enabled).join(", ") : "(none)"}`);
  console.log(`Existing HANDOVER.md and ${TOOL_DIR} files were left in place.`);
}

function status() {
  const root = findProjectRoot(process.cwd());
  const project = projectPaths(root);
  const config = readJson(project.configFile, {});
  const agents = config.agents || {};
  const queue = listJsonFiles(project.queueDir).length;
  const done = listJsonFiles(project.doneDir).length;
  const failed = listJsonFiles(project.failedDir).length;

  console.log(`${CLI_NAME}: ${config.enabled === true ? "ON" : "OFF"}`);
  console.log(`Project: ${root}`);
  console.log(`Handover: ${project.handoverFile} (${fs.existsSync(project.handoverFile) ? "exists" : "missing"})`);
  console.log(`Template: ${project.templateFile} (${fs.existsSync(project.templateFile) ? "exists" : "missing"})`);
  console.log(`Queue: ${queue} pending, ${done} done, ${failed} failed`);
  for (const name of AGENTS) {
    const adapter = getAdapter(name);
    const entry = agents[name] || {};
    const hook = adapter.projectHookFileStatus(root);
    console.log(`[${name}] enabled: ${entry.enabled === true} | model: ${entry.model || adapter.defaultModel} | available: ${adapter.isAvailable()} | hook file: ${hook.exists ? "exists" : "missing"}`);
  }
}

// ---------------------------------------------------------------------------
// enqueue (hook entrypoint)
// ---------------------------------------------------------------------------

async function enqueue(args) {
  // Recursion guard: the worker spawns the agent, which fires its own Stop hook.
  if (process.env[WORKER_ENV] === "1") return;

  const agent = parseAgentValue(args) || "claude";
  const stdin = await readStdin();
  let payload = {};
  if (stdin.trim()) {
    try {
      payload = JSON.parse(stdin);
    } catch {
      payload = { raw_stdin: stdin };
    }
  }

  // Secondary guard: agents mark re-entrant Stop events.
  if (payload.stop_hook_active === true) return;

  const root = findProjectRoot(payload.cwd || process.cwd());
  const project = projectPaths(root);
  const config = readJson(project.configFile, {});
  if (config.enabled !== true) return;
  const agentConfig = (config.agents || {})[agent];
  if (!agentConfig || agentConfig.enabled !== true) return;

  ensureDir(project.queueDir);
  const job = {
    id: `${safeFileStamp()}-${process.pid}-${Math.random().toString(16).slice(2)}`,
    agent,
    createdAt: timestamp(),
    cwd: payload.cwd || process.cwd(),
    hookEventName: payload.hook_event_name || "Stop",
    sessionId: payload.session_id || null,
    turnId: payload.turn_id || (payload.stop && payload.stop.turn_id) || null,
    stopReason: payload.stop_reason || null,
    model: payload.model || null,
    transcriptPath: payload.transcript_path || null,
    permissionMode: payload.permission_mode || null,
    payload: trimPayload(payload)
  };
  const jobFile = path.join(project.queueDir, `${job.id}.json`);
  writeJson(jobFile, job);
  if (process.env[NO_WORKER_ENV] !== "1") {
    startDetachedWorker(project);
  }
}

// ---------------------------------------------------------------------------
// prompt-router (@handover ... interception)
// ---------------------------------------------------------------------------

async function promptRouter(args) {
  const agent = parseAgentValue(args) || "claude";
  const adapter = getAdapter(agent);
  const stdin = await readStdin();
  let payload = {};
  if (stdin.trim()) {
    try {
      payload = JSON.parse(stdin);
    } catch {
      payload = {};
    }
  }

  const prompt = String(payload.prompt || "").trim();
  const parsed = parseInternalCommand(prompt);
  if (!parsed) return;
  promptRouterLog(`matched ${parsed.display}`);

  const cwd = payload.cwd || process.cwd();
  const result = childProcess.spawnSync(process.execPath, [process.argv[1], ...parsed.args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PBHANDOVER_ROUTER_CHILD: "1" },
    timeout: 60 * 1000,
    maxBuffer: 1024 * 1024
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const reason = output || `${parsed.display} completed.`;
  console.log(adapter.formatRouterResponse(parsed.display, reason));
  promptRouterLog(`handled ${parsed.display} status=${result.status}`);
}

function router(args) {
  const sub = args[0] || "status";
  const requested = parseAgentFlags(args.slice(1));
  const targets = (requested && requested.length)
    ? requested.map(getAdapter)
    : allAdapters().filter((adapter) => adapter.isAvailable());
  const adapters = targets.length ? targets : allAdapters();

  if (sub === "install") {
    for (const adapter of adapters) adapter.installRouter();
    return;
  }
  if (sub === "uninstall") {
    for (const adapter of adapters) adapter.uninstallRouter();
    console.log(`Command router: uninstalled (${adapters.map((a) => a.name).join(", ")})`);
    return;
  }
  if (sub === "status") {
    for (const adapter of allAdapters()) {
      for (const line of adapter.routerStatusLines()) console.log(line);
    }
    return;
  }
  throw new Error(`Unknown router command: ${sub}`);
}

async function trust(args) {
  const root = args.find((a) => !a.startsWith("--")) ? path.resolve(args.find((a) => !a.startsWith("--"))) : process.cwd();
  const codex = getAdapter("codex");
  await codex.trust(root);
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

function worker(args) {
  const foreground = args.includes("--foreground");
  const projectArgIndex = args.indexOf("--project");
  const root = projectArgIndex >= 0 && args[projectArgIndex + 1]
    ? path.resolve(args[projectArgIndex + 1])
    : findProjectRoot(process.cwd());
  const project = projectPaths(root);
  const lock = acquireLock(project.lockFile);
  if (!lock) {
    if (foreground) console.log("A worker is already running.");
    return;
  }

  try {
    ensureDir(project.doneDir);
    ensureDir(project.failedDir);
    let processed = 0;
    while (true) {
      const next = listJsonFiles(project.queueDir)[0];
      if (!next) break;
      processJob(project, next);
      processed += 1;
    }
    if (foreground) console.log(`Processed ${processed} job(s).`);
  } finally {
    releaseLock(project.lockFile, lock);
  }
}

function processJob(project, jobFile) {
  const job = readJson(jobFile, null);
  if (!job) return;
  const agentName = job.agent || "claude";
  const adapter = getAdapter(agentName);
  const config = readJson(project.configFile, {});
  const agentConfig = (config.agents || {})[agentName] || {};
  const model = agentConfig.model || adapter.defaultModel;
  const prompt = buildPrompt(project, job);
  const promptFile = path.join(project.toolDir, "last-prompt.md");
  const outFile = path.join(project.toolDir, adapter.lastMessageFile);
  atomicWrite(promptFile, prompt);

  const timeout = Number(config.workerTimeoutMs || 10 * 60 * 1000);
  const result = adapter.runSummarizer({ root: project.root, model, prompt, outFile, timeout });

  // The agent's Write/Edit tools (and interrupted atomic writes) can leave
  // stray HANDOVER.md.tmp.* files in the project root. Sweep them every job.
  cleanupTempFiles(project.handoverFile);

  if (adapter.summaryFromStdout) {
    try {
      atomicWrite(outFile, redact(String(result.stdout || "")));
    } catch {
      // Capturing the last message is best effort.
    }
  }

  const completedAt = timestamp();
  const baseName = path.basename(jobFile);
  if (result.status === 0) {
    job.completedAt = completedAt;
    job.agentStatus = result.status;
    job.agentSignal = result.signal || null;
    job.agentMessageFile = outFile;
    writeJson(path.join(project.doneDir, baseName), job);
    fs.unlinkSync(jobFile);
    appendWorkerLog(project, `ok ${agentName} ${baseName}`);
    return;
  }

  job.failedAt = completedAt;
  job.agentStatus = result.status;
  job.agentSignal = result.signal || null;
  job.error = result.error ? result.error.message : null;
  job.stderr = redact(String(result.stderr || "")).slice(-8000);
  job.stdout = redact(String(result.stdout || "")).slice(-8000);
  writeJson(path.join(project.failedDir, baseName), job);
  fs.unlinkSync(jobFile);
  appendWorkerLog(project, `failed ${agentName} ${baseName}: ${job.error || job.stderr || result.status}`);
}

function buildPrompt(project, job) {
  const tmpl = readText(project.templateFile, readText(DEFAULT_TEMPLATE));
  const promptRules = readText(project.promptFile, readText(DEFAULT_PROMPT));
  const existing = readText(project.handoverFile, "");
  const transcriptSummary = readTranscriptTail(job.transcriptPath);
  return `${promptRules}

Agent that produced this turn:
${job.agent || "unknown"}

Project root:
${project.root}

Output file (edit this file only, in place):
${project.handoverFile}

Template to follow:
--- TEMPLATE START ---
${tmpl}
--- TEMPLATE END ---

Existing HANDOVER.md:
--- EXISTING START ---
${redact(existing).slice(-30000)}
--- EXISTING END ---

Queued turn/job:
--- JOB START ---
${JSON.stringify(redactObject(job), null, 2)}
--- JOB END ---

Transcript tail, if available:
--- TRANSCRIPT TAIL START ---
${transcriptSummary}
--- TRANSCRIPT TAIL END ---

Now update ${HANDOVER_FILE} only, using your Write/Edit tools. Do not modify any other file. Do not print the file content to stdout; write it to disk.`;
}

function readTranscriptTail(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    const stat = fs.statSync(transcriptPath);
    const max = 60000;
    const start = Math.max(0, stat.size - max);
    const fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return redact(buffer.toString("utf8"));
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------

function template(args) {
  const sub = args[0] || "path";
  const root = findProjectRoot(process.cwd());
  const project = projectPaths(root);
  if (sub === "path") {
    console.log(`Shared template: ${path.join(userConfigDir(), "template.md")}`);
    console.log(`Project template: ${project.templateFile}`);
    return;
  }
  if (sub === "sync") {
    setup(["--quiet", "--no-router"]);
    const force = args.includes("--force");
    copyFileIfMissing(path.join(userConfigDir(), "template.md"), project.templateFile, force);
    console.log(`${force ? "Synced" : "Ensured"} project template: ${project.templateFile}`);
    return;
  }
  throw new Error(`Unknown template command: ${sub}`);
}

// ---------------------------------------------------------------------------
// agent selection helpers
// ---------------------------------------------------------------------------

function defaultAgentsConfig() {
  const agents = {};
  for (const name of AGENTS) {
    agents[name] = { enabled: false, model: getAdapter(name).defaultModel };
  }
  return agents;
}

function parseAgentFlags(args) {
  const flags = AGENTS.filter((name) => args.includes(`--${name}`));
  return flags.length ? flags : null;
}

function parseAgentValue(args) {
  const idx = args.indexOf("--agent");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  // also accept --claude / --codex shorthand
  const flag = AGENTS.find((name) => args.includes(`--${name}`));
  return flag || null;
}

function resolveAgentsForOn(args, root) {
  const requested = parseAgentFlags(args);
  if (requested) return requested;
  const detected = AGENTS.filter((name) => {
    const adapter = getAdapter(name);
    return adapter.isConfigured(root) || adapter.isAvailable();
  });
  return detected.length ? detected : [...AGENTS];
}

// ---------------------------------------------------------------------------
// prompt router parsing
// ---------------------------------------------------------------------------

function parseInternalCommand(prompt) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:@handover|\/handover|handover|pbhandover)\s+(.+)$/i);
  if (!match) return null;
  const parts = match[1].split(" ").filter(Boolean);
  const command = parts[0] ? parts[0].toLowerCase() : "";
  const allowed = new Set(["on", "off", "status", "doctor", "flush", "setup"]);
  if (!allowed.has(command)) return null;
  const args = [command, ...parts.slice(1)];
  return { args, display: `${CLI_NAME} ${args.join(" ")}` };
}

function promptRouterLog(message) {
  try {
    const logFile = path.join(userConfigDir(), "prompt-router.log");
    ensureDir(path.dirname(logFile));
    fs.appendFileSync(logFile, `${timestamp()} ${message}\n`, "utf8");
  } catch {
    // Logging must never make the hook fail.
  }
}

// ---------------------------------------------------------------------------
// gitignore
// ---------------------------------------------------------------------------

function updateGitignore(root, options) {
  const file = path.join(root, ".gitignore");
  const current = readText(file, "");
  const lines = current.split(/\r?\n/);
  const required = [`${TOOL_DIR}/`];
  // Anchor HANDOVER.md to repo root: on a case-insensitive filesystem an
  // unanchored "HANDOVER.md" also matches paths like commands/handover.md.
  if (!options.trackHandover) required.unshift(`/${HANDOVER_FILE}`);
  if (!options.trackHooks) {
    for (const name of options.agents) required.push(getAdapter(name).hookIgnoreEntry());
  }
  const missing = required.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  const block = ["", `# ${CLI_NAME}`, ...missing, ""].join("\n");
  writeText(file, `${current.replace(/\s*$/, "")}${block}`);
}

// ---------------------------------------------------------------------------
// project paths / queue / locks
// ---------------------------------------------------------------------------

function findProjectRoot(start) {
  let dir = path.resolve(start || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, TOOL_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start || process.cwd());
}

function projectPaths(root) {
  const toolDir = path.join(root, TOOL_DIR);
  return {
    root,
    toolDir,
    configFile: path.join(toolDir, "config.json"),
    templateFile: path.join(toolDir, "template.md"),
    promptFile: path.join(toolDir, "prompt.md"),
    queueDir: path.join(toolDir, "queue"),
    doneDir: path.join(toolDir, "done"),
    failedDir: path.join(toolDir, "failed"),
    lockFile: path.join(toolDir, "worker.lock"),
    handoverFile: path.join(root, HANDOVER_FILE)
  };
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(dir, name));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

function acquireLock(lockFile) {
  ensureDir(path.dirname(lockFile));
  try {
    const fd = fs.openSync(lockFile, "wx");
    const lock = { pid: process.pid, startedAt: timestamp() };
    fs.writeFileSync(fd, JSON.stringify(lock));
    fs.closeSync(fd);
    return lock;
  } catch (error) {
    if (error && error.code !== "EEXIST") throw error;
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (existing.startedAt && Date.now() - Date.parse(existing.startedAt) > 30 * 60 * 1000) {
        fs.unlinkSync(lockFile);
        return acquireLock(lockFile);
      }
    } catch {
      fs.unlinkSync(lockFile);
      return acquireLock(lockFile);
    }
    return null;
  }
}

function releaseLock(lockFile, lock) {
  try {
    const existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (existing.pid === lock.pid && existing.startedAt === lock.startedAt) fs.unlinkSync(lockFile);
  } catch {
    // Ignore stale lock cleanup failures.
  }
}

function startDetachedWorker(project) {
  const root = project.root;
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Start-Process -WindowStyle Hidden -FilePath ${psSingleQuoted(process.execPath)} -ArgumentList @(${[
        process.argv[1],
        "worker",
        "--project",
        root
      ].map(psSingleQuoted).join(", ")}) -WorkingDirectory ${psSingleQuoted(root)}`
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = childProcess.spawnSync("powershell.exe", [
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded
    ], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000
    });
    if (result.error || result.status !== 0) {
      appendWorkerLog(project, `worker launch failed: ${result.error ? result.error.message : result.status}`);
    }
    return;
  }

  const child = childProcess.spawn(process.execPath, [process.argv[1], "worker", "--project", root], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function appendWorkerLog(project, line) {
  ensureDir(project.toolDir);
  fs.appendFileSync(path.join(project.toolDir, "worker.log"), `${timestamp()} ${line}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// stdin / redaction
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) data = data.slice(-2 * 1024 * 1024);
    });
    process.stdin.on("end", () => resolve(data));
    if (process.stdin.isTTY) resolve("");
  });
}

function trimPayload(payload) {
  const copy = redactObject(payload);
  if (copy.transcript_path) copy.transcript_path = String(copy.transcript_path);
  return copy;
}

function redactObject(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  return JSON.parse(redact(serialized));
}

function redact(text) {
  return String(text)
    .replace(/(api[_-]?key|token|secret|password|passwd|authorization)(["'\s:=]+)([^"',\s}]+)/gi, "$1$2[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

module.exports = { main };
