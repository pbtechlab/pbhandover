"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { USER_DIR_NAME } = require("./defaults");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file, fallback = "") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function copyFileIfMissing(source, target, force = false) {
  ensureDir(path.dirname(target));
  if (!force && fs.existsSync(target)) return false;
  fs.copyFileSync(source, target);
  return true;
}

function atomicWrite(file, text) {
  ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, file);
}

function userConfigDir() {
  return path.join(os.homedir(), USER_DIR_NAME);
}

function claudeHomeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function codexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function timestamp() {
  return new Date().toISOString();
}

function safeFileStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isSubPath(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

module.exports = {
  atomicWrite,
  claudeHomeDir,
  codexHomeDir,
  copyFileIfMissing,
  ensureDir,
  isSubPath,
  readJson,
  readText,
  safeFileStamp,
  timestamp,
  userConfigDir,
  writeJson,
  writeText
};
