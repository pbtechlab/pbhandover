# pbhandover

`pbhandover` is a single npm CLI that keeps **one shared `HANDOVER.md`** — a living project handover note — automatically up to date for **Claude Code, Codex CLI, and Muse Code**. It works through each agent's **Stop hook**, and it is **non-blocking**: when a turn ends the hook only enqueues a tiny job and returns immediately. A detached background worker then asks an agent (in headless mode) to summarize the latest turn into `HANDOVER.md`. Your agent never waits on the handover update.

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
- **One shared `HANDOVER.md`** at the project root, written and read by all enabled agents.
- **Per-firing-agent summarization** — each Stop hook tags its job with which agent fired (`--agent claude` / `--agent codex`). The worker summarizes that job with the **same** agent (Claude turns by Claude, Codex turns by Codex). Models are configurable per agent.
- **In-session control** — type `@handover on|off|status|flush` (also `setup`/`doctor`) directly inside a Claude Code or Codex session. Claude Code also exposes a native `/handover` slash command.
- **Non-blocking** — the Stop hook just enqueues; the worker runs detached in the background.
- **Recursion-safe** — guards prevent the worker's own agent run from triggering an endless handover loop.
- **Secret redaction** — API keys, tokens, secrets, passwords, `Bearer` tokens, and `sk-...` keys are stripped from queued payloads, transcripts, and captured output.

## Requirements

- Node.js **18 or later**
- npm and Git
- The agent(s) you want to use:
  - **Claude Code** CLI (`claude` on your `PATH`) — for Claude integration
  - **Muse Code** (`muse`, native or WSL) — Muse integration
  - **Codex CLI** (`codex` on your `PATH`) — for Codex integration
- Windows, macOS, or Linux

You do not need all enabled agents. `pbhandover on` auto-detects which agents are present and enables only those.

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

   With no agent flags this **auto-detects** agents: it enables every agent whose project dir (`.claude` / `.codex` / `.muse`) exists, or whose CLI is installed. If none is detected, install an agent or select an adapter explicitly.

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
| `pbhandover on [--claude] [--codex] [--muse] [--track-handover] [--track-hooks] [--force-template]` | Enable the Stop hook in the current project. No agent flag → **auto-detect** (see [Quickstart](#quickstart)). Creates `.pbhandover/`, the project template/prompt/config, `HANDOVER.md`, and each selected agent's Stop hook. Updates private Git exclusions. |
| `pbhandover off [--claude] [--codex] [--muse]` | Disable this tool's Stop hook in the current project. No flag → all currently configured agents. Leaves `HANDOVER.md` and `.pbhandover/` in place. |
| `pbhandover status` (alias `doctor`) | Show global ON/OFF, the handover/template paths, queue counts (pending/done/failed), and per-agent `enabled` / `model` / `available` / hook-file status. |
| `pbhandover router install\|uninstall\|status [--claude] [--codex] [--muse]` | Manage the `@handover` `UserPromptSubmit` router and the `/handover` slash command. No flag → available agents for install/uninstall; `status` always reports all agents. |
| `pbhandover trust` | Trust this tool's installed Codex hooks (writes `[hooks.state.*]` entries into `~/.codex/config.toml`). |
| `pbhandover enqueue --agent claude\|codex` | **Internal** Stop hook entrypoint. Writes one queued job and spawns the worker, then returns. You normally do not run this manually. |
| `pbhandover worker` | **Internal.** Process queued jobs sequentially in the background. |
| `pbhandover flush` | Process queued jobs in the foreground and wait until the queue drains. |
| `pbhandover template path\|sync [--force]` | `path` prints the shared and project template paths. `sync` creates the project template from the shared one (`--force` overwrites). |
| `pbhandover --help` / `-h` | Show usage. |
| `pbhandover --version` / `-V` | Print the version. |

### `on` options

- `--claude` / `--codex` / `--muse` — enable only the named agent(s). With no agent flags, agents are auto-detected.
- `--track-handover` — create a repository-local tracking exception for `HANDOVER.md`.
- `--track-hooks` — create repository-local tracking exceptions for agent hook files.
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
  Stop hook fires ──► pbhandover enqueue --agent <claude|codex|muse>
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
       • codex:  codex exec [--model <model>] --output-last-message ...
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
| Codex CLI | `CLI default (no model override)` | `codex --disable hooks [--model <model>] --sandbox workspace-write --ask-for-approval never exec --skip-git-repo-check --output-last-message <file> -` |

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

The default template is in Japanese and has ten sections (project purpose; current work/tasks; commands run; successes/completed tasks; failures/errors; suspected causes; attempted fixes; next actions/backlog; cautions; other notable items), plus a "last updated" line and an "agent" field that records which agent (claude, codex, or muse) produced the update.

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
    "codex":  { "enabled": false, "model": null },
    "muse":   { "enabled": false, "model": null }
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
    "codex":  { "enabled": true, "model": null },
    "muse":   { "enabled": true, "model": null }
  }
}
```

- `enabled` — whether the project has handover enabled at all (true if any agent is enabled).
- `agents.<name>.enabled` — per-agent on/off.
- `agents.<name>.model` — the model used to summarize that agent's turns. Change it to any model id/alias the agent accepts.
- `trackHandover` / `trackHooks` — whether repository-local tracking exceptions are requested.
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

`on` adds runtime exclusions to the user's global Git exclusion file
(`core.excludesFile`), creating `~/.gitignore_global` and configuring Git if
necessary. It does not write private paths or comments into public `.gitignore`.
Configure exclusions on each machine. Ignoring files does not untrack files that
are already committed.

Exclusions cover handover notes, backups, temporary files, runtime state, personal
hook settings, and common secret-file patterns. `--track-handover` and
`--track-hooks` write repository-local exceptions into `.git/info/exclude` when a
Git repository exists. Higher-priority ignore rules may still apply; inspect them
with `git check-ignore -v`.

Redaction is best effort. Review output before sharing it. Never commit private
transcripts, credentials, or machine-specific bridge configuration. Use `local/`
for non-distributed local work.

## Muse Code (native and Windows + WSL)

Version 0.2 adds a third adapter, `muse`. Windows can run pbhandover with Windows
Node.js while Muse runs inside a WSL Linux distribution. Both use the same project
queue, lock, and `HANDOVER.md`; Linux Node.js is not required for this bridge.

### Requirements and setup

- pbhandover: Node.js 18 or newer and Git.
- Muse: a working `muse` installation with native plugin capabilities and `exec`.
- Windows bridge: WSL, Python 3 and `wslpath` in the selected distribution, and
  Windows executable interop enabled.
- Muse authentication and a usable model are configured separately in Muse.

From a Windows terminal in the shared project:

```powershell
pbhandover on --muse
pbhandover status
```

To enable all three explicitly:

```powershell
pbhandover on --claude --codex --muse
```

By default, Windows looks for native Muse first, then searches installed WSL
Linux distributions (excluding Docker Desktop distributions). To select one:

```powershell
$env:PBHANDOVER_WSL_DISTRO = 'Ubuntu'
pbhandover on --muse
```

Use a name from `wsl --list --quiet`. `PBHANDOVER_MUSE_BIN` overrides a native Muse
executable; if that explicit override is missing, detection reports unavailable
instead of silently selecting WSL. The other executable overrides remain
`PBHANDOVER_CLAUDE_BIN` and `PBHANDOVER_CODEX_BIN`.

For native Linux/macOS, install Node.js and Muse in the same environment and run
the same CLI commands without the Windows bridge.

### Plugin registration and commands

The adapter generates a native Muse plugin, validates it with `muse plugins
validate`, installs it at user scope, then approves only the pbhandover plugin's
capabilities. It contains `Stop` and `UserPromptSubmit` hooks. It does not rely on
a guessed `.muse/hooks.json` format or a `muse hooks` command.

The user plugin is shared across projects. Its Stop hook only queues jobs for
projects whose pbhandover configuration enables `muse`. Therefore `off --muse`
disables this project's generation while keeping `@handover` available. Removing
the Muse router removes that shared plugin and its Stop hook for all projects:

```sh
pbhandover router install --muse
pbhandover router status
pbhandover router uninstall --muse
```

Inside Muse, use `@handover on`, `@handover off`, `@handover status`, or `@handover
flush`. `setup` and `doctor` are also recognized. The prompt hook executes the
command locally and passes the result as additional context for Muse to display.
It does not return a block decision, which Muse displays as an interrupted turn.
Reporting the result uses a model response; ordinary prompts pass through. The native `/handover` slash command remains Claude-only.
Restart already-running agent sessions after installing or changing hooks.

### WSL bridge and summarization

The generated plugin lives under `~/.pbhandover/muse-plugin` on the pbhandover host.
Its Python bridge runs from Muse's verified plugin cache, translates the payload's
working directory and transcript path using `wslpath`, then invokes Windows Node.
This also supports WSL-owned transcript paths through Windows WSL filesystem
access. Python bytecode generation is disabled to preserve the plugin cache hash.

The worker invokes `muse exec --workspace ... --prompt-file ... --session-id ...
--approval-mode never --no-foreign-personal-context --disable-web-tools`. Sandbox
settings remain Muse's defaults. Output writes that Muse policy denies cause the
job to fail; there is no automatic sandbox bypass. The default model is Muse's
configured default. Set `agents.muse.model` in the project config to override it.

Muse filters hook environments, so a worker's environment variable alone cannot
prevent recursion. pbhandover records each summarizer's session ID under the
project's runtime `worker-sessions/` directory before launch. Its hooks ignore
those sessions even when `PBHANDOVER_WORKER` is absent. Keep those marker files
while related sessions may still emit hooks.

The worker writes a translated `muse-prompt.md` and captures the final process
output in `last-muse-message.txt`. A zero exit without a changed handover is
recorded as failure, not a successful update. Malformed queue JSON is moved to
`failed/` so it cannot trap processing of later jobs.

## Compatibility verification

Verified versions:

| Agent | Version checked | Checks |
| --- | --- | --- |
| Claude Code | 2.1.263 | Latest npm release executable; headless arguments; current hook contract |
| Codex CLI | 0.153.4 | Installed/npm release; exec arguments; live hook discovery, trust configuration, and successful background updates |
| Muse Code | 1.0.3 (1.0.3-R2198.1) | WSL executable; plugin validation/approval; actual Stop and prompt hook runner; headless execution; successful live background handover update |

The automated suite uses fake summarizers and temporary projects. It checks
configuration preservation, CRLF/duplicate trust entries, queue processing,
redaction, recursion guards, and router responses without spending model quota.
A live Muse Stop event also triggered the normal background summarizer and
successfully changed HANDOVER.md. Codex background updates also succeeded after switching an existing model override
to the CLI default. Claude model-generated updates were not exercised.

New Codex configurations no longer pin Spark: a null/omitted model uses the CLI's
configured default. Existing explicitly configured models are preserved. If an
existing Spark configuration hits its separate usage limit, choose an available
model in `agents.codex.model`, or set it to null to use the CLI default. There is
no automatic fallback to a different model or provider.

The Codex trust updater handles LF/CRLF, replaces duplicate entries for the same
hook, and preserves other TOML tables. Agent executable detection checks actual
files; native Claude installations and npm Codex shims are supported. Hook changes
preserve unrelated handlers even when they share a matcher group.

References: [Claude hook reference](https://code.claude.com/docs/en/hooks),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Muse Code](https://dev.meta.ai/docs/muse-code/). Muse-specific registration was
also verified against the installed executable's native plugin contract and CLI
validator because access to its web documentation may require login.
