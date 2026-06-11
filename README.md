# pbhandover

`pbhandover` is a single npm CLI that keeps **one shared `HANDOVER.md`** — a living project handover note — automatically up to date for **both Claude Code and Codex CLI**. It works through each agent's **Stop hook**, and it is **non-blocking**: when a turn ends the hook only enqueues a tiny job and returns immediately. A detached background worker then asks an agent (in headless mode) to summarize the latest turn into `HANDOVER.md`. Your agent never waits on the handover update.

日本語版は [README.ja.md](README.ja.md) を参照してください。

- Repository: <https://github.com/pbtechlab/pbhandover>
- License: MIT

---

## Table of contents

- [What problem it solves](#what-problem-it-solves)
- [Highlights](#highlights)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Daily use: `@handover` inside a session](#daily-use-handover-inside-a-session)
- [Command reference](#command-reference)
- [How it works (architecture)](#how-it-works-architecture)
  - [Two levels of files](#two-levels-of-files)
  - [The `.pbhandover/` project layout](#the-pbhandover-project-layout)
  - [End-to-end flow](#end-to-end-flow)
  - [Per-firing-agent summarization](#per-firing-agent-summarization)
  - [Recursion safety](#recursion-safety)
  - [Secret redaction](#secret-redaction)
  - [Template & prompt copy flow](#template--prompt-copy-flow)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)
- [Agent integration details](#agent-integration-details)
- [Uninstall](#uninstall)
- [FAQ & troubleshooting](#faq--troubleshooting)
- [Development](#development)
- [Privacy & Git](#privacy--git)

---

## What problem it solves

When an agent session gets long, the next turn — or the next agent, or the next human — needs a short, current handover note: what the project is, what is being worked on, what commands were run, what succeeded, what failed, what is suspected, what was tried, what to do next, and what should not be touched.

`pbhandover` automates that note and keeps it shared across agents:

- An agent finishes a turn and its `Stop` event fires.
- The Stop hook quickly writes one queued job and returns (non-blocking).
- A detached background worker processes queued jobs one at a time.
- For each job, the worker runs the **same agent that produced the turn** in headless mode to refresh the single shared `HANDOVER.md` from a template.
- Because `HANDOVER.md` is shared, a handover continues seamlessly whether your last turn was in Claude Code or in Codex.

The generated handover files are local by default. They can include machine-specific details, so the tool excludes them from Git unless you explicitly opt in.

## Highlights

- **One shared state directory per project** — `.pbhandover/` holds config, template, prompt, the queue, logs, and the worker lock.
- **One shared `HANDOVER.md`** at the project root, written and read by both agents.
- **Per-firing-agent summarization** — each Stop hook tags its job with which agent fired (`--agent claude` / `--agent codex`). The worker summarizes that job with the **same** agent (Claude turns by Claude, Codex turns by Codex). Models are configurable per agent.
- **In-session control** — type `@handover on|off|status|flush` (also `setup`/`doctor`) directly inside a Claude Code or Codex session. Claude Code also exposes a native `/handover` slash command.
- **Non-blocking** — the Stop hook just enqueues; the worker runs detached in the background.
- **Recursion-safe** — guards prevent the worker's own agent run from triggering an endless handover loop.
- **Secret redaction** — API keys, tokens, secrets, passwords, `Bearer` tokens, and `sk-...` keys are stripped from queued payloads, transcripts, and captured output.

## Requirements

- Node.js **18 or later**
- npm
- The agent(s) you want to use:
  - **Claude Code** CLI (`claude` on your `PATH`) — for Claude integration
  - **Codex CLI** (`codex` on your `PATH`) — for Codex integration
- Windows, macOS, or Linux

You do not need both agents. `pbhandover on` auto-detects which agents are present and enables only those.

On Windows, run commands in PowerShell or Command Prompt. On macOS/Linux, use Terminal, bash, or zsh.

## Installation

Global install from the npm registry:

```sh
npm install -g pbhandover
```

A package `postinstall` script runs `pbhandover setup --quiet` on a best-effort basis (it never fails the install). `setup` creates the shared user template/prompt/config and installs the `@handover` command router for every agent that is available on your machine.

Global installation does **not** automatically enable handover generation for all projects. You still enable each project separately with `pbhandover on` (or `@handover on` inside a session).

## Quickstart

1. Open a terminal and `cd` into the project where you want `HANDOVER.md` maintained.
2. Enable handover for the project:

   ```sh
   pbhandover on
   ```

   With no agent flags this **auto-detects** agents: it enables every agent whose project dir (`.claude` / `.codex`) exists, or whose CLI is installed. If none is detected, it falls back to enabling all known agents.

3. Check the setup:

   ```sh
   pbhandover status
   ```

4. Work normally in Claude Code and/or Codex. Each time an agent finishes a turn, the Stop hook queues a handover update and the background worker refreshes `HANDOVER.md`.
5. Before closing the project or handing it off, drain any pending jobs:

   ```sh
   pbhandover flush
   ```

You can also do all of this from inside an agent session — see below.

## Daily use: `@handover` inside a session

This is the primary, everyday way to drive the tool. Inside a **Claude Code** or **Codex** session, type:

```text
@handover on
@handover off
@handover status
@handover flush
```

`@handover setup` and `@handover doctor` are also accepted (`doctor` is an alias of `status`).

How it works: a `UserPromptSubmit` router intercepts prompts that start with `@handover` (also `/handover`, `handover`, or `pbhandover`), runs the matching CLI subcommand locally in the project, and returns the result back to the session **without** sending it to the model as a normal prompt.

- In **Claude Code**, the router responds with a `block` decision, so `@handover ...` never costs model tokens. Claude Code additionally supports the native **`/handover`** slash command (`/handover on`, `/handover status`, etc.), which runs the same CLI through the Bash tool.
- In **Codex**, the router runs the command locally and injects the result as additional context, asking Codex to report the result instead of treating the prompt as an ordinary request.

Only this fixed set of subcommands is routed: `on`, `off`, `status`, `doctor`, `flush`, `setup`. Anything else is passed through to the model normally.

## Command reference

| Command | What it does |
| --- | --- |
| `pbhandover setup [--force] [--no-router]` | Create the shared user `template.md`, `prompt.md`, and `config.json`, and install the `@handover` command router (+ `/handover` slash command) for every available agent. `--force` overwrites the shared template/prompt with package defaults. `--no-router` skips router installation. |
| `pbhandover on [--claude] [--codex] [--track-handover] [--track-hooks] [--force-template]` | Enable the Stop hook in the current project. No agent flag → **auto-detect** (see [Quickstart](#quickstart)). Creates `.pbhandover/`, the project template/prompt/config, `HANDOVER.md`, and each selected agent's Stop hook. Updates `.gitignore`. |
| `pbhandover off [--claude] [--codex]` | Disable this tool's Stop hook in the current project. No flag → all currently configured agents. Leaves `HANDOVER.md` and `.pbhandover/` in place. |
| `pbhandover status` (alias `doctor`) | Show global ON/OFF, the handover/template paths, queue counts (pending/done/failed), and per-agent `enabled` / `model` / `available` / hook-file status. |
| `pbhandover router install\|uninstall\|status [--claude] [--codex]` | Manage the `@handover` `UserPromptSubmit` router and the `/handover` slash command. No flag → available agents for install/uninstall; `status` always reports all agents. |
| `pbhandover trust` | Trust this tool's installed Codex hooks (writes `[hooks.state.*]` entries into `~/.codex/config.toml`). |
| `pbhandover enqueue --agent claude\|codex` | **Internal** Stop hook entrypoint. Writes one queued job and spawns the worker, then returns. You normally do not run this manually. |
| `pbhandover worker` | **Internal.** Process queued jobs sequentially in the background. |
| `pbhandover flush` | Process queued jobs in the foreground and wait until the queue drains. |
| `pbhandover template path\|sync [--force]` | `path` prints the shared and project template paths. `sync` creates the project template from the shared one (`--force` overwrites). |
| `pbhandover --help` / `-h` | Show usage. |
| `pbhandover --version` / `-V` | Print the version. |

### `on` options

- `--claude` / `--codex` — enable only the named agent(s). With neither flag, agents are auto-detected.
- `--track-handover` — keep `HANDOVER.md` out of `.gitignore` (by default it is ignored).
- `--track-hooks` — keep the agent hook files out of `.gitignore`.
- `--force-template` — overwrite the project-local template and prompt from the shared user copies.

## How it works (architecture)

### Two levels of files

**User-level (shared by every project on your machine)** — created by `setup`:

- Shared dir: `~/.pbhandover/` (Windows: `%USERPROFILE%\.pbhandover\`)
  - `template.md` — default handover structure for new projects
  - `prompt.md` — default worker writing policy
  - `config.json` — default queue mode, handover filename, redaction flag, per-agent default models
  - `prompt-router.log` — log of routed `@handover` commands
- Claude user settings: `~/.claude/settings.json` (router hook) — base dir overridable via `CLAUDE_CONFIG_DIR`
- Claude slash command: `~/.claude/commands/handover.md`
- Codex user hooks: `~/.codex/hooks.json` (router hook) — base dir overridable via `CODEX_HOME`

**Project-level (created in the current project by `on`)**:

- `.pbhandover/` — the shared, agent-neutral state dir (see layout below)
- `.claude/settings.local.json` — Claude Stop hook entry (when Claude is enabled)
- `.codex/hooks.json` — Codex Stop hook entry (when Codex is enabled)
- `HANDOVER.md` — the shared handover note at the project root

The user-level template is the starting point; each project gets its own copy, so editing one project's template does not affect other projects.

### The `.pbhandover/` project layout

```text
your-project/
  HANDOVER.md                       # shared handover note (project root)
  .claude/
    settings.local.json             # Claude Stop hook (personal; git-ignored by default)
  .codex/
    hooks.json                      # Codex Stop hook (git-ignored by default)
  .pbhandover/
    config.json                     # project config (enabled, agents, models, tracking flags)
    template.md                     # project-local handover structure
    prompt.md                       # project-local worker writing policy
    queue/                          # pending jobs (one JSON per queued turn)
    done/                           # completed job records
    failed/                         # failed job records (for inspection)
    worker.log                      # background worker log
    worker.lock                     # single-worker lock (stale after 30 min)
    last-prompt.md                  # last prompt sent to a summarizer
    last-claude-message.txt         # last message captured from Claude
    last-codex-message.txt          # last message captured from Codex
```

> Note: `last-prompt.md`, `last-claude-message.txt`, and `last-codex-message.txt` are written by the worker as it processes jobs, so they appear once a handover update has run.

### End-to-end flow

```text
  Agent finishes a turn (Claude Code or Codex)
            │
            ▼
  Stop hook fires ──► pbhandover enqueue --agent <claude|codex>
            │            • recursion guards check (see below)
            │            • writes ONE job into .pbhandover/queue/
            │            • spawns a detached background worker
            ▼            • returns immediately  (NON-BLOCKING)
  Agent is free to continue — no waiting

  ── meanwhile, in the background ───────────────────────────────

  pbhandover worker
            │  • takes the single worker.lock
            │  • for each queued job, oldest first:
            ▼
     buildPrompt():  prompt rules + template + existing HANDOVER.md
                     + redacted job + redacted transcript tail
            │
            ▼
     runSummarizer() with the SAME agent that fired the hook
       • claude: claude -p --model <model> --output-format text
       • codex:  codex exec --model <model> --output-last-message ...
       (worker sets PBHANDOVER_WORKER=1 so the agent's own Stop
        hook is a no-op — this breaks the recursion)
            │
            ▼
     Agent edits HANDOVER.md in place (writes to disk, not stdout)
            │
            ▼
     success → job moved to done/      failure → job moved to failed/
            │
            ▼
     repeat until the queue is empty, then release the lock
```

### Per-firing-agent summarization

Each Stop hook tags its job with the agent that fired it (`--agent claude` or `--agent codex`). When the worker processes a job, it summarizes that turn with the **same** agent, so the model that produced the work also writes the handover:

| Agent | Default summarizer model | Headless invocation |
| --- | --- | --- |
| Claude Code | `claude-haiku-4-5-20251001` | `claude -p --model <model> --dangerously-skip-permissions --output-format text` (summary captured from stdout) |
| Codex CLI | `gpt-5.3-codex-spark` | `codex --disable hooks --model <model> --sandbox workspace-write --ask-for-approval never exec --skip-git-repo-check --output-last-message <file> -` |

Models are configurable per agent in `.pbhandover/config.json` (see [Configuration](#configuration)).

### Recursion safety

The worker spawns an agent in headless mode, and that agent fires its **own** Stop hook when it finishes — which could enqueue another handover job forever. Two guards prevent the loop:

1. The worker sets the environment variable `PBHANDOVER_WORKER=1`. The `enqueue` command returns immediately whenever it sees this, so the summarizer's Stop hook does nothing.
2. `enqueue` also returns immediately when the agent's hook payload contains `stop_hook_active: true` (the agents mark re-entrant Stop events).

### Secret redaction

Before anything is written to the queue, used in a prompt, or captured to disk, text is passed through a redaction filter that masks:

- `api_key` / `api-key` / `apikey`, `token`, `secret`, `password` / `passwd`, and `authorization` values → `[REDACTED]`
- `sk-...` style keys (20+ chars) → `sk-[REDACTED]`
- `Bearer <token>` → `Bearer [REDACTED]`

Redaction covers queued payloads, the transcript tail, the existing `HANDOVER.md` excerpt fed to the summarizer, and captured stdout/stderr. It is a safety net, not a guarantee — review generated files before sharing.

### Template & prompt copy flow

```text
1. Package default:  templates/default-template.md   prompts/default-prompt.md
2. User shared    :  ~/.pbhandover/template.md        ~/.pbhandover/prompt.md     (created by setup)
3. Project-local  :  .pbhandover/template.md          .pbhandover/prompt.md       (copied by on)
4. HANDOVER.md created from the project-local template
```

When the worker builds a prompt it reads, in priority order: the project-local template → falling back to the bundled default. Because the template is read per job, editing `.pbhandover/template.md` changes the next handover update. Edit the project-local template when one project needs a different format; edit the user-level shared template to change the default for future projects.

The default template is in Japanese and has ten sections (project purpose; current work/tasks; commands run; successes/completed tasks; failures/errors; suspected causes; attempted fixes; next actions/backlog; cautions; other notable items), plus a "last updated" line and an "agent" field that records which agent (claude or codex) produced the update.

## Configuration

### Shared user config — `~/.pbhandover/config.json`

Created by `setup`:

```json
{
  "queueMode": "sequential",
  "handoverFile": "HANDOVER.md",
  "redactSecrets": true,
  "agents": {
    "claude": { "enabled": false, "model": "claude-haiku-4-5-20251001" },
    "codex":  { "enabled": false, "model": "gpt-5.3-codex-spark" }
  }
}
```

### Project config — `.pbhandover/config.json`

Created/updated by `on`:

```json
{
  "enabled": true,
  "trackHandover": false,
  "trackHooks": false,
  "queueMode": "sequential",
  "handoverFile": "HANDOVER.md",
  "templateFile": ".pbhandover/template.md",
  "promptFile": ".pbhandover/prompt.md",
  "agents": {
    "claude": { "enabled": true, "model": "claude-haiku-4-5-20251001" },
    "codex":  { "enabled": true, "model": "gpt-5.3-codex-spark" }
  }
}
```

- `enabled` — whether the project has handover enabled at all (true if any agent is enabled).
- `agents.<name>.enabled` — per-agent on/off.
- `agents.<name>.model` — the model used to summarize that agent's turns. Change it to any model id/alias the agent accepts.
- `trackHandover` / `trackHooks` — whether `HANDOVER.md` and the hook files are kept out of `.gitignore`.
- `workerTimeoutMs` (optional) — per-job summarizer timeout in milliseconds. Defaults to `600000` (10 minutes) when unset.

## Environment variables

| Variable | Effect |
| --- | --- |
| `PBHANDOVER_WORKER=1` | Set by the worker around the summarizer run. When present, `enqueue` is a no-op. This is the primary recursion guard — you normally do not set it yourself. |
| `PBHANDOVER_NO_WORKER=1` | `enqueue` writes the job but does **not** spawn the background worker. Useful for tests or when you want to control worker runs manually with `flush`. |
| `PBHANDOVER_CLAUDE_BIN` | Override the `claude` binary used for summarization. |
| `PBHANDOVER_CODEX_BIN` | Override the `codex` binary used for summarization. |
| `CLAUDE_CONFIG_DIR` | Override Claude's home dir (default `~/.claude`); affects where the router hook and slash command are installed. |
| `CODEX_HOME` | Override Codex's home dir (default `~/.codex`); affects where the router hook and `config.toml` trust entries are written. |

## Agent integration details

### Claude Code

- **Project Stop hook** — added to `.claude/settings.local.json` under `hooks.Stop`, running `... enqueue --agent claude`.
- **User router** — a `hooks.UserPromptSubmit` entry in `~/.claude/settings.json` running `... prompt-router --agent claude`.
- **Slash command** — `~/.claude/commands/handover.md` is installed so `/handover ...` works natively.

### Codex CLI

- **Project Stop hook** — added to `.codex/hooks.json` under `hooks.Stop`, running `... enqueue --agent codex`.
- **User router** — a `hooks.UserPromptSubmit` entry in `~/.codex/hooks.json` running `... prompt-router --agent codex`.
- **Hook trust** — Codex requires hooks to be trusted. `on` automatically trusts pbhandover's hooks (via `postEnable`), and you can re-run it any time with `pbhandover trust`. Trust works by querying the Codex `app-server` for the installed hooks and writing `[hooks.state.<key>]` blocks (with `trusted_hash` and `enabled = true`) into `~/.codex/config.toml`. Run `trust` again after reinstalling/moving the package or editing the generated hook commands.

## Uninstall

### Disable one project

```sh
cd path/to/your/project
pbhandover off
```

This removes this tool's Stop hook entries but leaves `.pbhandover/` and `HANDOVER.md` for review.

### Remove local project files

After confirming you no longer need them, delete `HANDOVER.md` and `.pbhandover/`, and remove the pbhandover Stop entries from `.claude/settings.local.json` and/or `.codex/hooks.json` (delete those files entirely only if they hold no other settings you use).

### Remove the user-level router and slash command

```sh
pbhandover router uninstall
```

### Remove the global npm package

```sh
npm uninstall -g pbhandover
```

### Optional user-level cleanup

Only after uninstalling, remove the shared dir if it is no longer needed:

- Windows: `%USERPROFILE%\.pbhandover`
- macOS/Linux: `~/.pbhandover`

## FAQ & troubleshooting

**`pbhandover` is not found.** Ensure npm's global bin is on your `PATH` (`npm bin -g` / `npm config get prefix`), then restart the terminal.

**`@handover on` is treated like a normal prompt.** Install/refresh the router with `pbhandover router install` (for Codex also run `pbhandover trust`), then restart the agent in that project.

**`HANDOVER.md` is not updating.** Run `pbhandover status` to inspect queue counts, then `pbhandover flush` to process pending jobs in the foreground. Inspect `.pbhandover/worker.log` and the `.pbhandover/failed/` directory for errors.

**A handover update never ran (queue stays pending).** The detached worker may have failed to launch — check `.pbhandover/worker.log`. You can always drain the queue manually with `pbhandover flush`. If you intentionally set `PBHANDOVER_NO_WORKER=1`, jobs only run via `flush`/`worker`.

**I changed the template but the file still looks old.** Run `pbhandover flush`. The worker reads the project template per job, so the next processed job uses the new format.

**"A worker is already running."** Only one worker runs at a time, guarded by `.pbhandover/worker.lock`. A stale lock (older than 30 minutes) is reclaimed automatically. If needed, delete `worker.lock` manually after confirming no worker is active.

**Codex says the hook is untrusted.** Run `pbhandover trust` (and restart Codex). This rewrites the `[hooks.state.*]` trust entries in `~/.codex/config.toml`.

**Which agent summarizes which turn?** The same agent that produced the turn. Claude turns are summarized by Claude, Codex turns by Codex — each with its configured model.

## Development

```sh
npm install
npm test          # node --test
npm run smoke     # pbhandover --help
node bin/pbhandover.js --help
```

## Privacy & Git

By default, `on` adds the following to `.gitignore`:

```gitignore
/HANDOVER.md
.pbhandover/
.claude/settings.local.json   # when Claude is enabled
.codex/hooks.json             # when Codex is enabled
```

`HANDOVER.md` is anchored with a leading `/` so it only matches the repo-root file (important on case-insensitive filesystems). Use `--track-handover` / `--track-hooks` to keep those files tracked.

Keep secrets out of handover files, queue files, prompts, templates, and logs: API keys, tokens, passwords, `.env` contents, private keys, internal server names, and personal or customer data. Payloads, transcript tails, and captured output are passed through a redaction filter, but always review generated files before sharing a repository, issue reproduction, or support bundle.
