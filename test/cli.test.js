"use strict";

const test = require("node:test");
const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "bin", "pbhandover.js");

function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbhandover-test-"));
  const home = path.join(tmp, "home");
  const proj = path.join(tmp, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  return { tmp, home, proj };
}

function run(args, { cwd, home, input }) {
  return childProcess.spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input: input || "",
    encoding: "utf8",
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
      PBHANDOVER_NO_WORKER: "1"
    }
  });
}

test("--help lists the unified command surface", () => {
  const res = run(["--help"], { cwd: process.cwd(), home: os.tmpdir() });
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /shared HANDOVER\.md for Claude Code and Codex CLI/);
  assert.match(res.stdout, /@handover on/);
});

test("on --claude enables the project and installs a Stop hook", () => {
  const { tmp, home, proj } = makeSandbox();
  try {
    const res = run(["on", "--claude"], { cwd: proj, home });
    assert.strictEqual(res.status, 0, res.stderr);

    const config = JSON.parse(fs.readFileSync(path.join(proj, ".pbhandover", "config.json"), "utf8"));
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.agents.claude.enabled, true);

    const settings = JSON.parse(fs.readFileSync(path.join(proj, ".claude", "settings.local.json"), "utf8"));
    const command = settings.hooks.Stop[0].hooks[0].command;
    assert.match(command, /pbhandover/);
    assert.match(command, /enqueue --agent claude/);

    assert.ok(fs.existsSync(path.join(proj, "HANDOVER.md")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("enqueue writes a tagged job; off disables", () => {
  const { tmp, home, proj } = makeSandbox();
  try {
    run(["on", "--claude"], { cwd: proj, home });

    const payload = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
    const enq = run(["enqueue", "--agent", "claude"], { cwd: proj, home, input: payload });
    assert.strictEqual(enq.status, 0, enq.stderr);

    const queueDir = path.join(proj, ".pbhandover", "queue");
    const jobs = fs.readdirSync(queueDir).filter((n) => n.endsWith(".json"));
    assert.strictEqual(jobs.length, 1);
    const job = JSON.parse(fs.readFileSync(path.join(queueDir, jobs[0]), "utf8"));
    assert.strictEqual(job.agent, "claude");

    const off = run(["off"], { cwd: proj, home });
    assert.strictEqual(off.status, 0, off.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(proj, ".pbhandover", "config.json"), "utf8"));
    assert.strictEqual(config.agents.claude.enabled, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("enqueue is a no-op when disabled (no job written)", () => {
  const { tmp, home, proj } = makeSandbox();
  try {
    run(["on", "--claude"], { cwd: proj, home });
    run(["off"], { cwd: proj, home });
    const payload = JSON.stringify({ hook_event_name: "Stop" });
    run(["enqueue", "--agent", "claude"], { cwd: proj, home, input: payload });
    const queueDir = path.join(proj, ".pbhandover", "queue");
    const jobs = fs.readdirSync(queueDir).filter((n) => n.endsWith(".json"));
    assert.strictEqual(jobs.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("prompt-router returns Claude block format for @handover status", () => {
  const { tmp, home, proj } = makeSandbox();
  try {
    run(["on", "--claude"], { cwd: proj, home });
    const res = run(["prompt-router", "--agent", "claude"], {
      cwd: proj,
      home,
      input: JSON.stringify({ prompt: "@handover status" })
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.decision, "block");
    assert.match(out.reason, /pbhandover: ON/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("prompt-router stays silent for non-@handover prompts", () => {
  const { tmp, home, proj } = makeSandbox();
  try {
    run(["on", "--claude"], { cwd: proj, home });
    const res = run(["prompt-router", "--agent", "claude"], {
      cwd: proj,
      home,
      input: JSON.stringify({ prompt: "build the project" })
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout.trim(), "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
