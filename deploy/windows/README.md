# Windows deploy

Windows-only deployment for this repo. `install.sh` at the repo root stays the
POSIX path; these scripts exist because that one cannot run as-is on Windows (the
`bash` on PATH is WSL's Linux bash, which writes to the wrong filesystem).

| File | Purpose |
|---|---|
| `install-windows.ps1` | Installs the plugin, Cursor adapter, schedule jobs and the shared skill into `%USERPROFILE%`, then initialises and verifies the store. `-RepoDir` defaults to the repository root. |
| `merge-opencode.py` | JSONC-tolerant merge of the autolearn agent entry into `~/.config/opencode/opencode.json`. Called by the installer, so keep the two files together. |

Run from the repository root:

```powershell
.\deploy\windows\install-windows.ps1
```

The preflight checks `uv`, `python3` and Windows Developer Mode (the skill store
uses `os.symlink`, which needs it).
