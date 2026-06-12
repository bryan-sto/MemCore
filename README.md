# MemCore (Lightweight Local Memory Server)

MemCore is a lightweight, high-performance, single-process local memory server clone for AI coding agents. It serves as a drop-in replacement for `agentmemory`, solving its native Windows reliability issues.

## Features

- **Single-Process Coexistence**: Starts both the stdio MCP server (for direct agent interaction) and the HTTP REST API (port `3111`) inside the same event loop.
- **Zero Dependencies**: Uses native Node.js libraries, including the built-in `node:sqlite` module (available in Node.js 22.5+). No compilation issues, ZIP downloads, or binary packaging.
- **Ultra-Fast Search**: Leverages SQLite's native FTS5 (Full-Text Search) virtual tables for keyword ranking, with a robust fallback to fuzzy `LIKE` queries if FTS parsing fails.
- **Robust Windows Compatibility**: Bypasses Windows `.cmd` execution bugs by invoking the process using `node` directly from `settings.json`.

---

## Architecture

```
[Agent CLI / IDE]
   │
   ├── (stdio JSON-RPC) ────────► [ MemCore Server ] ◄──────── (HTTP REST on 3111)
   │                                   │
   │                                   ▼
   │                         [ SQLite: db.sqlite ]
   │                     (Sessions, Memories, Slots, Lessons)
```

- **Database Path**: `C:\Users\acer\.memcore\db.sqlite`
- **Port**: `3111` (for REST calls)

---

## MCP Tools Supported

MemCore implements the core set of tools that agents call:

1. `memory_save`: Explicitly save an important insight, decision, or file pattern to long-term memory.
2. `memory_smart_search` / `memory_recall`: Search past session observations using FTS5 keyword indexing.
3. `memory_sessions`: List recent session metadata.
4. `memory_lesson_save`: Record a lesson learned. Multiple saves of the same content automatically reinforce confidence.
5. `memory_lesson_recall`: Search lessons learned sorted by confidence and recency.
6. `memory_slot_create` / `memory_slot_get` / `memory_slot_replace` / `memory_slot_list` / `memory_slot_delete`: Persistent clipboard slots that persist across session boundaries.
7. `memory_consolidate` / `memory_reflect` / `memory_diagnose`: Compatibility mocks returning successful health reports to ensure agent stability.

---

## HTTP REST Endpoints (Port 3111)

- **Liveness**: `GET http://localhost:3111/agentmemory/livez`
- **Start Session**: `POST http://localhost:3111/agentmemory/session/start`
- **End Session**: `POST http://localhost:3111/agentmemory/session/end`
- **Remember**: `POST http://localhost:3111/agentmemory/remember`
- **Search**: `POST http://localhost:3111/agentmemory/smart-search`
- **Lessons**: `POST/GET http://localhost:3111/agentmemory/lessons`
- **Lessons Search**: `POST http://localhost:3111/agentmemory/lessons/search`
- **Slots**: `GET http://localhost:3111/agentmemory/slots`
- **Slot Replace**: `POST http://localhost:3111/agentmemory/slot/replace`
- **Slot Append**: `POST http://localhost:3111/agentmemory/slot/append`

---

## Startup Configuration

MemCore is registered directly in the agent's MCP settings at `C:\Users\acer\.gemini\settings.json`:

```json
"agentmemory": {
  "type": "stdio",
  "command": "node",
  "args": [
    "D:/Personal Project/am/index.js"
  ]
}
```
