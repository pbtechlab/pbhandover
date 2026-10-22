"use strict";

const claude = require("./claude");
const codex = require("./codex");
const muse = require("./muse");
const cline = require("./cline");
const { AGENTS } = require("../defaults");

const REGISTRY = { claude, codex, muse, cline };

function getAdapter(name) {
  const adapter = REGISTRY[name];
  if (!adapter) throw new Error(`Unknown agent: ${name}. Known agents: ${AGENTS.join(", ")}`);
  return adapter;
}

function allAdapters() {
  return AGENTS.map((name) => REGISTRY[name]);
}

module.exports = { getAdapter, allAdapters };
