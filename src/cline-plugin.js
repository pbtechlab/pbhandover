"use strict";

const cp = require("node:child_process");

// A second guard covers plugin sandboxes that do not inherit the worker env.
const WORKER_PREFIX = "[pbhandover-summary-worker]\n";

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function userText(message) {
  const text = messageText(message).trim();
  // Cline CLI wraps accepted prompts before passing them to runtime hooks.
  const wrapped = text.match(/^<user_input(?:\s+[^>]*)?>([\s\S]*)<\/user_input>$/);
  return wrapped ? wrapped[1].trim() : text;
}

function createPlugin({ node, entry }) {
  let cwd;
  let sessionId;
  let worker = false;
  let handled = false;
  function invoke(command, payload) {
    const result = cp.spawnSync(node, [entry, command, "--agent", "cline"], {
      cwd, input: JSON.stringify(payload), encoding: "utf8", windowsHide: true,
      timeout: command === "prompt-router" ? 65000 : 10000, maxBuffer: 1024 * 1024
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `pbhandover exited ${result.status}`);
    return result.stdout.trim();
  }
  return {
    name: "pbhandover",
    manifest: { capabilities: ["hooks"] },
    setup(_api, ctx = {}) {
      cwd = ctx.cwd || ctx.workspaceRoot || ctx.workspaceInfo?.rootPath;
      sessionId = ctx.session?.sessionId;
    },
    hooks: {
      beforeRun({ snapshot }) {
        handled = false;
        const messages = snapshot.messages || [];
        const firstUser = messages.find((message) => message.role === "user");
        worker = process.env.PBHANDOVER_WORKER === "1" || userText(firstUser).startsWith(WORKER_PREFIX);
        if (worker || snapshot.parentAgentId || !cwd) return;
        const latest = messages.at(-1);
        if (latest?.role !== "user") return;
        const prompt = userText(latest);
        if (!/^(?:@handover|\/handover|handover|pbhandover)\s+/i.test(prompt)) return;
        const output = invoke("prompt-router", { cwd, prompt, taskId: sessionId || snapshot.conversationId });
        if (!output) return;
        handled = true;
        return { appendContext: JSON.parse(output).contextModification };
      },
      beforeModel({ request } = {}) {
        // Command results need only a short reply, with no duplicate tool execution.
        // Yolo runs must retain their completion tool to finish the turn.
        if (handled) return { tools: (request?.tools || []).filter((tool) => tool.name === "submit_and_exit") };
      },
      afterRun({ snapshot, result }) {
        if (worker || snapshot.parentAgentId || result.status !== "completed" || !cwd) return;
        invoke("enqueue", {
          cwd, taskId: sessionId || snapshot.conversationId, hookName: "TaskComplete",
          turn_id: snapshot.runId || result.runId,
          last_assistant_message: result.outputText || "",
          transcript_tail: JSON.stringify(snapshot.messages || result.messages || []).slice(-60000)
        });
      }
    }
  };
}

module.exports = { createPlugin, WORKER_PREFIX };
