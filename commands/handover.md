---
description: Control pbhandover (on/off/status/flush) for this project
argument-hint: on | off | status | flush
allowed-tools: Bash(pbhandover:*)
---

Run exactly this command and report its full output verbatim to the user. Do not do anything else, do not edit files, do not explain.

```bash
pbhandover $ARGUMENTS
```

If `$ARGUMENTS` is empty, run `pbhandover status`.
