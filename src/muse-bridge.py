"""Bridge Muse's WSL hook payload to the Windows Node CLI (stdlib only)."""
import json
import os
from pathlib import Path
import subprocess
import sys


def windows_path(value):
    if not value or not str(value).startswith("/"):
        return value
    return subprocess.check_output(["wslpath", "-w", str(value)], text=True).strip()


def main(command):
    config = json.loads(Path(__file__).with_name("bridge.json").read_text(encoding="utf-8"))
    payload = json.load(sys.stdin)
    for key in ("cwd", "transcript_path"):
        if key in payload:
            payload[key] = windows_path(payload[key])
    payload.setdefault("cwd", windows_path(os.getcwd()))
    env = dict(os.environ)
    env["PBHANDOVER_WSL_DISTRO"] = config["distro"]
    # Windows programs launched through WSL only receive exported variables
    # explicitly named in WSLENV.
    env["WSLENV"] = ":".join(filter(None, [env.get("WSLENV"), "PBHANDOVER_WSL_DISTRO"]))
    result = subprocess.run([config["node"], config["entry"], command, "--agent", "muse"],
                            input=json.dumps(payload, ensure_ascii=False),
                            text=True, encoding="utf-8", capture_output=True, env=env)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)
