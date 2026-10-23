"""Compatibility entry point for the Node.js mock sender (Python 3 stdlib only)."""

from pathlib import Path
import subprocess
import sys

if __name__ == "__main__":
    backend = Path(__file__).resolve().parents[1] / "backend"
    raise SystemExit(subprocess.call(
        ["node", "--env-file-if-exists=.env", "scripts/simulate.js", *sys.argv[1:]],
        cwd=backend,
    ))

