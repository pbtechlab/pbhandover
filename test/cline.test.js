"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { isSubPath } = require("../src/fs-utils");
const { WORKER_PREFIX } = require("../src/cline-plugin");
const BIN = path.resolve(__dirname, "../bin/pbhandover.js");

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pbhandover-cline-"));
  t.after(() => {
    assert.ok(isSubPath(os.tmpdir(), fs.realpathSync(base)));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, "workspace with spaces");
  const home = path.join(base, "home");
  fs.mkdirSync(root); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLINE_DIR: path.join(home, ".cline"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"),
    PBHANDOVER_MUSE_BIN: path.join(home, "no-muse"), PBHANDOVER_CLINE_BIN: path.join(home, "no-cline"),
    PBHANDOVER_WORKER: "", PBHANDOVER_NO_WORKER: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  function run(args, payload, preloader) {
    return cp.spawnSync(process.execPath, [...(preloader ? ["--require", preloader] : []), BIN, ...args], {
      cwd: root, env, input: payload ? JSON.stringify(payload) : "", encoding: "utf8", timeout: 10000
    });
  }
  const enabled = run(["on", "--cline"]);
  assert.equal(enabled.status, 0, enabled.stderr);
  return { base, root, home, env, run, pluginFile: path.join(home, ".cline/plugins/pbhandover.js") };
}

test("Cline plugin routes the same commands, queues completed turns, and respects off", (t) => {
  const box = sandbox(t);
  const script = path.join(box.base, "exercise.cjs");
  fs.writeFileSync(script, `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const plugin = require(${JSON.stringify(box.pluginFile)});
    plugin.setup({}, {cwd:${JSON.stringify(box.root)}, session:{sessionId:'cline-task'}});
    const user = text => ({role:'user',content:[{type:'text',text}]});
    const snapshot = {messages:[user('<user_input mode="yolo">@handover status</user_input>')], conversationId:'conversation',runId:'turn-1'};
    const response = plugin.hooks.beforeRun({snapshot});
    assert.match(response.appendContext,/pbhandover: ON/);
    assert.deepEqual(plugin.hooks.beforeModel(), {tools:[]});
    assert.deepEqual(plugin.hooks.beforeModel({request:{tools:[{name:'run_commands'},{name:'submit_and_exit'}]}}), {tools:[{name:'submit_and_exit'}]});
    snapshot.messages = [user('Implement a feature'), {role:'assistant',content:[{type:'text',text:'Feature completed'}]}];
    assert.equal(plugin.hooks.beforeRun({snapshot}), undefined);
    assert.equal(plugin.hooks.beforeModel(), undefined);
    plugin.hooks.afterRun({snapshot,result:{status:'completed',outputText:'password=example-secret'}});
    const queue = path.join(${JSON.stringify(box.root)},'.pbhandover/queue');
    const files = fs.readdirSync(queue);
    assert.equal(files.length,1);
    const body = fs.readFileSync(path.join(queue,files[0]),'utf8');
    const job = JSON.parse(body);
    assert.equal(job.agent,'cline');
    assert.equal(job.sessionId,'cline-task');
    assert.equal(job.turnId,'turn-1');
    assert.equal(job.hookEventName,'TaskComplete');
    assert.match(job.payload.transcript_tail,/Feature completed/);
    assert.ok(!body.includes('example-secret'));
    snapshot.messages = [user('@handover off --cline')];
    assert.match(plugin.hooks.beforeRun({snapshot}).appendContext,/pbhandover: OFF/);
    plugin.hooks.afterRun({snapshot,result:{status:'completed',outputText:'off'}});
    assert.equal(fs.readdirSync(queue).length,1);
    snapshot.messages = [user('@handover on --cline')];
    assert.match(plugin.hooks.beforeRun({snapshot}).appendContext,/pbhandover: ON/);
    snapshot.messages = [user('@handover flush')];
    fs.unlinkSync(path.join(queue,files[0]));
    assert.match(plugin.hooks.beforeRun({snapshot}).appendContext,/Processed 0 job/);
  `);
  const result = cp.spawnSync(process.execPath, [script], { cwd: box.base, env: box.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test("Cline ignores summarizer sessions, subagents and incomplete turns", (t) => {
  const box = sandbox(t);
  const script = path.join(box.base, "guards.cjs");
  fs.writeFileSync(script, `
    const plugin = require(${JSON.stringify(box.pluginFile)});
    plugin.setup({}, {cwd:${JSON.stringify(box.root)}});
    const user = text => ({role:'user',content:[{type:'text',text}]});
    let snapshot = {messages:[user(${JSON.stringify('<user_input mode="yolo">' + WORKER_PREFIX + 'Update HANDOVER.md</user_input>')})]};
    plugin.hooks.beforeRun({snapshot});
    plugin.hooks.afterRun({snapshot,result:{status:'completed'}});
    snapshot = {messages:[user('normal task')], parentAgentId:'parent'};
    plugin.hooks.beforeRun({snapshot});
    plugin.hooks.afterRun({snapshot,result:{status:'completed'}});
    snapshot = {messages:[user('normal task')]};
    plugin.hooks.beforeRun({snapshot});
    plugin.hooks.afterRun({snapshot,result:{status:'failed'}});
    process.env.PBHANDOVER_WORKER='1';
    plugin.hooks.beforeRun({snapshot});
    plugin.hooks.afterRun({snapshot,result:{status:'completed'}});
  `);
  const result = cp.spawnSync(process.execPath, [script], { env: box.env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(box.root, ".pbhandover/queue")), []);
});

test("Cline native hook payload preserves workspace and task identity", (t) => {
  const box = sandbox(t);
  const result = box.run(["enqueue", "--agent", "cline"], {
    workspaceRoots: [box.root], taskId: "native-task", hookName: "agent_end",
    last_assistant_message: "done"
  });
  assert.equal(result.status, 0, result.stderr);
  const queue = path.join(box.root, ".pbhandover/queue");
  const job = JSON.parse(fs.readFileSync(path.join(queue, fs.readdirSync(queue)[0])));
  assert.equal(job.sessionId, "native-task"); assert.equal(job.cwd, box.root);
  assert.equal(job.hookEventName, "agent_end");
  const routed = box.run(["prompt-router", "--agent", "cline"], { workspaceRoots: [box.root], userPromptSubmit: { prompt: "@handover status" } });
  assert.match(JSON.parse(routed.stdout).contextModification, /pbhandover: ON/);
});

test("Cline jobs use the shared worker and record a successful handover", (t) => {
  const box = sandbox(t);
  box.run(["enqueue", "--agent", "cline"], { cwd: box.root });
  const preloader = path.join(box.base, "summarizer.cjs");
  fs.writeFileSync(preloader, `require(${JSON.stringify(path.resolve(__dirname, "../src/adapters"))}).getAdapter('cline').runSummarizer = ({root}) => { require('node:fs').writeFileSync(require('node:path').join(root,'HANDOVER.md'),'Cline summary'); return {status:0,stdout:'done'}; };`);
  const result = box.run(["flush"], null, preloader);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Processed 1 job/);
  assert.equal(fs.readFileSync(path.join(box.root, "HANDOVER.md"), "utf8"), "Cline summary");
  assert.equal(fs.readdirSync(path.join(box.root, ".pbhandover/done")).length, 1);
});

test("Cline installation and removal preserve unrelated plugins", (t) => {
  const box = sandbox(t);
  const other = path.join(path.dirname(box.pluginFile), "other.js");
  fs.writeFileSync(other, "unrelated");
  assert.equal(box.run(["router", "install", "--cline"]).status, 0);
  assert.equal(box.run(["router", "uninstall", "--cline"]).status, 0);
  assert.ok(!fs.existsSync(box.pluginFile));
  assert.equal(fs.readFileSync(other, "utf8"), "unrelated");
  fs.writeFileSync(box.pluginFile, "user-owned plugin");
  assert.notEqual(box.run(["router", "install", "--cline"]).status, 0);
  assert.equal(fs.readFileSync(box.pluginFile, "utf8"), "user-owned plugin");
});
