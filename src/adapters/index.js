"use strict";

const claude = require("./claude");
const codex = require("./codex");
const { AGENTS } = require("../defaults");

const REGISTRY = { claude, codex };

function getAdapter(name) {
  const adapter = REGISTRY[name];
  if (!adapter) throw new Error(`Unknown agent: ${name}. Known agents: ${AGENTS.join(", ")}`);
  return adapter;
}

function allAdapters() {
  return AGENTS.map((name) => REGISTRY[name]);
}

module.exports = { getAdapter, allAdapters };
