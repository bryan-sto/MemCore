# New Machine Setup Guide: MemCore & pyrtk

Comprehensive guide for deploying MemCore (`agentmemory`) and `pyrtk` (`rtk`) on a clean machine without database contamination or tool collisions.

---

## 1. Collision & Isolation Analysis

Neither tool collides with Rust `rtk` or `claudemem`:

| Dimension | pyrtk (This Project) | Rust rtk | Collision Risk |
|---|---|---|---|
| CLI Executable | `pyrtk` | `rtk` | None (distinct names) |
| MCP Executable | `pyrtk-mcp` | `rtk` / custom | None (distinct names) |
| Storage Directory | `~/.pyrtk/` | `~/.rtk/` | None (isolated paths) |
| Port Usage | Connects to port 3111 | None (local CLI) | None |

| Dimension | MemCore (This Project) | claudemem | Collision Risk |
|---|---|---|---|
| Database Path | `~/.memcore/db.sqlite` | `~/.claude/...` | None (isolated storage) |
| MCP Identifier | `agentmemory` | `claudemem` / `memory` | None (distinct server keys) |
| HTTP Port | `3111` (configurable) | `3000` / stdio | None |
| Storage Backend | `node:sqlite` (local file) | SQLite / JSON | None |

---

## 2. Prerequisites on Target Machine

Install these runtimes on the new machine:

1. **Git**: Available on PATH (`git --version`).
2. **Node.js 22+**: Required for built-in `node:sqlite`. Verify with `node --version`.
3. **Python 3.12+**: Verify with `python --version`.
4. **uv**: Fast Python package installer. Verify with `uv --version`.
   - Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - macOS/Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`

---

## 3. Step-by-Step Installation

### Step 1: Install pyrtk Globally via uv

Run in terminal on the new machine:

```bash
uv tool install "git+https://github.com/bryan-sto/rtk.git"
```

*Alternative (if working from a local clone):*
```bash
git clone https://github.com/bryan-sto/rtk.git
uv tool install ./rtk
```

Verify global availability:
```bash
pyrtk version
# Windows:
where pyrtk-mcp
# Linux/macOS:
which pyrtk-mcp
```
Expected output: `pyrtk 0.2.0` and path to `pyrtk-mcp` binary on PATH.

### Step 2: Set Up MemCore (Fresh Memory State)

Clone the repository into a persistent folder (for example `~/.memcore`):

```bash
# Windows PowerShell:
git clone https://github.com/bryan-sto/MemCore.git $HOME/.memcore

# macOS / Linux:
git clone https://github.com/bryan-sto/MemCore.git ~/.memcore
```

Do NOT copy any existing `db.sqlite` file. On its first boot, MemCore automatically detects the absence of a database and initializes a fresh, empty schema with 0 records.

Test boot:
```bash
# Windows PowerShell:
node "$HOME/.memcore/index.js"

# macOS / Linux:
node ~/.memcore/index.js
```

Verify output confirms startup:
```text
MemCore v3.1.0 listening on http://127.0.0.1:3111
Database path: .../.memcore/db.sqlite
```
Press `Ctrl+C` to terminate the manual test run.

### Step 3: Configure MCP in Antigravity / Gemini CLI

Create or edit `~/.gemini/config/mcp_config.json`:

- Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`
- Linux/macOS: `~/.gemini/config/mcp_config.json`

Add the following JSON block:

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "node",
      "args": [
        "<PATH_TO_MEMCORE>/index.js"
      ],
      "env": {
        "MEMCORE_PORT": "3111"
      }
    },
    "pyrtk": {
      "command": "pyrtk-mcp",
      "env": {
        "MEMCORE_PORT": "3111"
      }
    }
  }
}
```

*Note on `<PATH_TO_MEMCORE>`:*
- Windows example: `C:/Users/username/.memcore/index.js`
- Linux/macOS example: `/home/username/.memcore/index.js`

### Step 4: Transfer Global Operating Instructions (GEMINI.md)

Copy your project operating instructions to the global configuration path:

- Windows: `%USERPROFILE%\.gemini\GEMINI.md`
- Linux/macOS: `~/.gemini/GEMINI.md`

Ensure Sections 13 (MemCore) and 18 (pyrtk) remain active so the agent automatically uses `rtk_run_command` and `agentmemory` tools.

---

## 4. Verification Checklist

Launch your AI coding agent on the new machine and verify:

1. **MCP Discovery**:
   - `memory_smart_search` tool is loaded under `agentmemory`.
   - `rtk_run_command` tool is loaded under `pyrtk`.

2. **Clean Memory State Verification**:
   - Call `memory_diagnose` or run in terminal:
     ```bash
     curl http://localhost:3111/agentmemory/stats
     ```
   - Confirms: `memories: 0`, `sessions: 0`, `edges: 0`.

3. **pyrtk Execution & Compression**:
   - Run a test command through `rtk_run_command`:
     Command: `git status`
   - Check local telemetry:
     ```bash
     pyrtk gain
     ```

4. **Viewer Dashboard (Optional)**:
   - Open `<PATH_TO_MEMCORE>/viewer.html` in any web browser.
   - Point to default port 3111 to monitor new memories visually.

---

## 5. Troubleshooting

- **Port Conflict (Port 3111 already in use)**:
  Set environment variable `MEMCORE_PORT=3112` in both `agentmemory` and `pyrtk` blocks in `mcp_config.json`.
  Open dashboard with `viewer.html?port=3112`.

- **pyrtk-mcp command not found**:
  Ensure uv's tool bin directory is on your system PATH:
  - Windows: `%USERPROFILE%\.local\bin`
  - Linux/macOS: `~/.local/bin`
  Restart your terminal or IDE after installation.
