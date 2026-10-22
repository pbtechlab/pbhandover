"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { upsertTrust } = require("../src/hook-utils");
const { findExecutable, resolveAgent } = require("../src/executables");
const { isSubPath } = require("../src/fs-utils");

const BIN = path.resolve(__dirname, "../bin/pbhandover.js");
const ADAPTERS = path.resolve(__dirname, "../src/adapters");

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pbhandover-compat-"));
  t.after(() => {
    assert.ok(isSubPath(os.tmpdir(), fs.realpathSync(root)));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: root, USERPROFILE: root,
    CLAUDE_CONFIG_DIR: path.join(root, "user-claude"), CODEX_HOME: path.join(root, "user-codex"),
    CLINE_DIR: path.join(root, "user-cline"),
    PBHANDOVER_MUSE_BIN: path.join(root, "no-muse"), PBHANDOVER_NO_WORKER: "1", PBHANDOVER_WORKER: "",
    PBHANDOVER_CLINE_BIN: path.join(root, "no-cline"),
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  return { root, env };
}

function run(box, args, payload, preloader) {
  return cp.spawnSync(process.execPath, [...(preloader ? ["--require", preloader] : []), BIN, ...args], {
    cwd: box.root, env: box.env, input: payload ? JSON.stringify(payload) : "", encoding: "utf8", timeout: 10000
  });
}

function seed(box, agent = "muse") {
  const state = path.join(box.root, ".pbhandover");
  fs.mkdirSync(path.join(state, "queue"), { recursive: true });
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify({ enabled: true, agents: { [agent]: { enabled: true, model: null } } }));
  fs.writeFileSync(path.join(box.root, "HANDOVER.md"), "before\n");
  return state;
}

test("trust updates handle CRLF, duplicate sections, quoted keys and following unrelated tables", () => {
  const key = "hooks.json:user_prompt_submit:0:0";
  const source = `[hooks.state.'${key}']\r\ntrusted_hash = "old"\r\nenabled = false\r\n` +
    `[profiles.work]\r\nmodel = "keep"\r\n` +
    `[hooks.state.'${key}']\r\ntrusted_hash = "duplicate"\r\n` +
    `[mcp_servers.example]\r\ncommand = "keep"\r\n`;
  const hooks = [{ key, currentHash: "new" }, { key: "a'b\\c", currentHash: "another" }];
  const output = upsertTrust(source, hooks);
  assert.equal((output.match(/hooks\.json:user_prompt_submit/g) || []).length, 1);
  assert.match(output, /\[profiles\.work\]\r\nmodel = "keep"/);
  assert.match(output, /\[mcp_servers\.example\]\r\ncommand = "keep"/);
  assert.ok(output.includes(`[hooks.state.${JSON.stringify("a'b\\c")}]`));
  assert.equal(upsertTrust(output, hooks), output);
});

for (const agent of ["claude", "codex"]) {
  test(`${agent} on/off preserves unrelated handlers in the same Stop group`, (t) => {
    const box = sandbox(t);
    const adapter = require(`../src/adapters/${agent}`);
    const file = path.join(box.root, agent === "claude" ? ".claude/settings.local.json" : ".codex/hooks.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const foreign = { type: "command", command: "another-tool stop" };
    fs.writeFileSync(file, JSON.stringify({ custom: "keep", hooks: { Stop: [{ matcher: "", hooks: [foreign, { type: "command", command: "pbhandover enqueue" }] }] } }));
    adapter.enableStopHook(box.root);
    adapter.enableStopHook(box.root);
    let data = JSON.parse(fs.readFileSync(file));
    assert.equal(data.hooks.Stop.flatMap((g) => g.hooks).length, 2);
    adapter.disableStopHook(box.root);
    data = JSON.parse(fs.readFileSync(file));
    assert.equal(data.custom, "keep");
    assert.deepEqual(data.hooks.Stop.flatMap((g) => g.hooks), [foreign]);
  });
}

test("missing agent overrides report unavailable", (t) => {
  const box = sandbox(t);
  const result = cp.spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.resolve(__dirname, "../src/executables"))}).resolveAgent('muse')))`], { env: box.env, encoding: "utf8" });
  assert.equal(result.stdout.trim(), "null");
  assert.equal(findExecutable("a-nonexistent-pbhandover-test-command"), null);
});

test("Muse detects legacy and nested plugin listings, including disabled entries", (t) => {
  const box = sandbox(t);
  const script = `
    const assert = require('node:assert/strict');
    const wsl = require(${JSON.stringify(path.resolve("src/wsl.js"))});
    let plugins;
    wsl.resolveMuse = () => ({command:'mock'});
    wsl.runMuse = () => ({status:0,stdout:JSON.stringify({plugins})});
    const adapter = require(${JSON.stringify(path.resolve("src/adapters/muse.js"))});
    for (const [listing, expected] of [
      [[{id:'pbhandover',enabled:true}],true],
      [[{id:'pbhandover',enabled:false}],false],
      [[{plugin:{id:'pbhandover'},record:{enabled:true},active:true}],true],
      [[{plugin:{id:'pbhandover'},record:{enabled:false},active:true}],false],
      [[{plugin:{id:'pbhandover'},record:{enabled:true},active:false}],false],
      [[{plugin:{id:'unrelated'},active:true}],false]
    ]) {plugins=listing;assert.equal(adapter.routerInstalled(),expected);}
  `;
  const result = cp.spawnSync(process.execPath, ["-e", script], { env: box.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("Windows Cline npm shim resolves to its native binary", {skip: process.platform !== "win32"}, (t) => {
  const box = sandbox(t);
  const shim = path.join(box.root, "cline.cmd");
  const binary = path.join(box.root, "node_modules/cline/node_modules/@cline", `cli-windows-${process.arch}/bin/cline.exe`);
  fs.mkdirSync(path.dirname(binary), {recursive:true});
  fs.writeFileSync(shim, "@echo off\r\n"); fs.writeFileSync(binary, "placeholder");
  assert.deepEqual(findExecutable(shim, [shim]), {command:binary,args:[],shell:false});
});

test("on uses private Git exclusions and leaves public .gitignore intact", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(path.join(box.root, ".gitignore"), "node_modules/\n/local/\n");
  const result = run(box, ["on", "--claude"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(box.root, ".gitignore"), "utf8"), "node_modules/\n/local/\n");
  assert.match(fs.readFileSync(path.join(box.root, ".gitignore_global"), "utf8"), /HANDOVER\.md/);
});

test("Muse payload is queued with its transcript and secrets redacted", (t) => {
  const box = sandbox(t); const state = seed(box);
  const payload = { cwd: box.root, hook_event_name: "Stop", session_id: "muse-session", transcript_path: path.join(box.root, "turn.jsonl"), last_assistant_message: "password=example-secret" };
  const result = run(box, ["enqueue", "--agent", "muse"], payload);
  assert.equal(result.status, 0, result.stderr);
  const jobs = fs.readdirSync(path.join(state, "queue"));
  assert.equal(jobs.length, 1);
  const body = fs.readFileSync(path.join(state, "queue", jobs[0]), "utf8");
  assert.equal(JSON.parse(body).agent, "muse");
  assert.equal(JSON.parse(body).transcriptPath, payload.transcript_path);
  assert.ok(!body.includes("example-secret"));
});

test("Muse session guard prevents recursion even when worker env is absent", (t) => {
  const box = sandbox(t); const state = seed(box);
  fs.mkdirSync(path.join(state, "worker-sessions"));
  fs.writeFileSync(path.join(state, "worker-sessions", "worker-123.json"), "{}");
  const result = run(box, ["enqueue", "--agent", "muse"], { cwd: box.root, session_id: "worker-123" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(state, "queue")), []);
});

test("worker environment and stop_hook_active both suppress enqueue", (t) => {
  const box = sandbox(t); const state = seed(box);
  assert.equal(run(box, ["enqueue", "--agent", "muse"], { stop_hook_active: true }).status, 0);
  box.env.PBHANDOVER_WORKER = "1";
  assert.equal(run(box, ["enqueue", "--agent", "muse"], {}).status, 0);
  assert.deepEqual(fs.readdirSync(path.join(state, "queue")), []);
});

test("Muse router returns result context without interrupting the turn", (t) => {
  const box = sandbox(t); seed(box);
  const result = run(box, ["prompt-router", "--agent", "muse"], { cwd: box.root, prompt: "@handover status" });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.decision, undefined);
  assert.notEqual(response.continue, false);
  assert.equal(response.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(response.hookSpecificOutput.additionalContext, /pbhandover: ON/);
  assert.match(response.hookSpecificOutput.additionalContext, /Do not execute/);
  assert.equal(run(box, ["prompt-router", "--agent", "muse"], { prompt: "edit a file" }).stdout, "");
});

test("Codex router retains current additionalContext format", (t) => {
  const box = sandbox(t); seed(box, "codex");
  const result = run(box, ["prompt-router", "--agent", "codex"], { cwd: box.root, prompt: "@handover status" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.match(output.additionalContext, /handled locally/);
});

test("worker processes Muse jobs, cleans temporary output, and records a successful update", (t) => {
  const box = sandbox(t); const state = seed(box);
  assert.equal(run(box, ["enqueue", "--agent", "muse"], { cwd: box.root }).status, 0);
  const preloader = path.join(box.root, "fake.cjs");
  fs.writeFileSync(preloader, `require(${JSON.stringify(ADAPTERS)}).getAdapter('muse').runSummarizer = ({root}) => { const fs=require('node:fs'); const p=require('node:path'); fs.writeFileSync(p.join(root,'HANDOVER.md'),'updated'); fs.writeFileSync(p.join(root,'HANDOVER.md.tmp.test'),'temporary'); return {status:0,stdout:'done'}; };`);
  const result = run(box, ["flush"], null, preloader);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Processed 1 job/);
  assert.equal(fs.readFileSync(path.join(box.root, "HANDOVER.md"), "utf8"), "updated");
  assert.equal(fs.readdirSync(path.join(state, "done")).length, 1);
  assert.ok(!fs.existsSync(path.join(box.root, "HANDOVER.md.tmp.test")));
});

test("worker does not mark a no-op summarizer as successful", (t) => {
  const box = sandbox(t); const state = seed(box);
  run(box, ["enqueue", "--agent", "muse"], { cwd: box.root });
  const preloader = path.join(box.root, "fake.cjs");
  fs.writeFileSync(preloader, `require(${JSON.stringify(ADAPTERS)}).getAdapter('muse').runSummarizer = () => ({status:0,stdout:''});`);
  const result = run(box, ["flush"], null, preloader);
  assert.equal(result.status, 0, result.stderr);
  const failed = fs.readdirSync(path.join(state, "failed"));
  assert.equal(failed.length, 1);
  assert.match(JSON.parse(fs.readFileSync(path.join(state, "failed", failed[0]))).error, /did not update/);
});

test("corrupt job is isolated instead of preventing later queue processing", (t) => {
  const box = sandbox(t); const state = seed(box);
  fs.writeFileSync(path.join(state, "queue", "broken.json"), "{");
  const result = run(box, ["flush"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readdirSync(path.join(state, "queue")).length, 0);
  assert.equal(fs.readdirSync(path.join(state, "failed")).length, 1);
});

test("detached worker handles a project path containing spaces", async (t) => {
  const box = sandbox(t);
  const outer = box.root;
  box.root = path.join(outer, "project with spaces");
  fs.mkdirSync(box.root);
  const state = seed(box);
  const preloader = path.join(outer, "summarizer.cjs");
  fs.writeFileSync(preloader, `require(${JSON.stringify(ADAPTERS)}).getAdapter('muse').runSummarizer = ({root}) => { require('node:fs').writeFileSync(require('node:path').join(root,'HANDOVER.md'),'detached update'); return {status:0,stdout:''}; };`);
  box.env.NODE_OPTIONS = `--require=${JSON.stringify(preloader)}`;
  box.env.PBHANDOVER_NO_WORKER = "";
  const result = run(box, ["enqueue", "--agent", "muse"], { cwd: box.root });
  assert.equal(result.status, 0, result.stderr);
  const deadline = Date.now() + 10000;
  const complete = () => fs.existsSync(path.join(state, "done")) && fs.readdirSync(path.join(state, "done")).length === 1 && !fs.existsSync(path.join(state, "worker.lock"));
  while (!complete() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(complete(), "Detached worker did not finish");
  assert.equal(fs.readFileSync(path.join(box.root, "HANDOVER.md"), "utf8"), "detached update");
});
