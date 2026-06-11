"use strict";

const path = require("node:path");

const PACKAGE_ROOT = path.resolve(__dirname, "..");

// Shared, agent-neutral project state directory. Both the Claude Code and
// Codex CLI integrations read and write the same queue and HANDOVER.md here so
// a handover continues seamlessly no matter which agent produced the turn.
const TOOL_DIR = ".pbhandover";

// Shared per-user config directory (template / prompt / config defaults).
const USER_DIR_NAME = ".pbhandover";

const HANDOVER_FILE = "HANDOVER.md";
const COMMANDS_DIR = "commands";
const SLASH_COMMAND_FILE = "handover.md";

const APP_NAME = "pbhandover";
const CLI_NAME = "pbhandover";

// Env var that breaks the enqueue -> worker -> agent -> Stop hook recursion.
const WORKER_ENV = "PBHANDOVER_WORKER";
const NO_WORKER_ENV = "PBHANDOVER_NO_WORKER";

// Known agent adapters. Order matters for auto-detection display.
const AGENTS = ["claude", "codex"];

module.exports = {
  AGENTS,
  APP_NAME,
  CLI_NAME,
  COMMANDS_DIR,
  HANDOVER_FILE,
  NO_WORKER_ENV,
  PACKAGE_ROOT,
  SLASH_COMMAND_FILE,
  TOOL_DIR,
  USER_DIR_NAME,
  WORKER_ENV
};
