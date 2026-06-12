# MemCore — Agent Auto-Capture Instructions

MemCore is running as an MCP server. Follow these rules every session without exception.

---

## SESSION START (run before any other action)

```
1. Call memory_smart_search with the user's first message or project name as the query.
2. If results exist, surface any relevant past decisions, bugs, or conventions at the
   top of your response before doing any work.
3. If no results exist, proceed normally.
```

---

## DURING THE SESSION (automatic saves — zero user prompting required)

Save to memory immediately when ANY of the following occur:

| Trigger | Tool to call | Type |
|---|---|---|
| A file is created or significantly changed | `memory_save` | `arch` or `convention` |
| A bug root cause is identified | `memory_save` | `bug` |
| User confirms a design decision | `memory_save` | `decision` |
| A non-obvious workaround is discovered | `memory_save` | `convention` |
| An error is solved after 2+ attempts | `memory_save` | `bug` |
| A new package/library is added | `memory_save` | `env` |
| The user says "remember this" | `memory_save` | (match what they said) |

**Concept tags rule:** Always populate `concepts` with 3–8 comma-separated keywords describing
the memory topic (e.g. `sqlite,fts5,search,performance`). This feeds the concept graph and makes
future searches find related memories automatically.

**Fire-and-forget:** Call `memory_save` in the background — do not block your response on it.
The server is local and writes in <5ms.

### Task & Goal Tracking (Slots)

When starting a complex, multi-step task:
1. Initialize a slot named `ACTIVE_GOALS` using `memory_slot_create` (or overwrite it using `memory_slot_replace`) outlining the steps of the task.
2. Update this slot as steps are completed using `memory_slot_replace` or `memory_slot_append`.
3. Clear or delete the slot (using `memory_slot_delete`) once the task is fully achieved and completed.

---

## POST TOOL USE (hook via MCP)

After running any tool that produces a significant result (file write, command output, search),
you MAY call `memory_hook` with:

```json
{
  "event": "PostToolUse",
  "tool_name": "<name of the tool>",
  "tool_result": "<first 500 chars of the result>",
  "project": "<project name>"
}
```

This is optional — use it for important tool results, not for every lookup.

---

## SESSION END (run before ending the conversation)

```
Call memory_session_summarize with no arguments.
This compresses the session's observations into a single searchable summary memory.
Future sessions will recall what was worked on today in one result.
```

---

## SEARCH TIPS

- `memory_smart_search` uses BM25 re-ranking + concept-graph expansion.
  Use natural language queries — it handles synonym gaps automatically.
- Use `memory_lesson_recall` for "best practices" style queries.
- `memory_reflect` shows the top concept graph for a project — useful for orienting
  at the start of a new session on an unfamiliar project.

---

## WHAT NOT TO SAVE

- Trivial lookup results (reading a file to understand it — not worth saving)
- Information that is obvious from reading the code
- Credentials, tokens, secrets, or PII
- Anything the user says to forget

---

## QUICK REFERENCE

```
memory_save               — save a memory (always populate concepts)
memory_smart_search       — recall anything (uses BM25 + concept graph)
memory_recall             — same as smart_search, with token_budget param
memory_lesson_save        — save a lesson (repeated saves = confidence++)
memory_lesson_recall      — find lessons by topic
memory_session_summarize  — compress current session (call at end)
memory_hook               — fire a lifecycle event (PostToolUse, etc.)
memory_reflect            — see concept graph top topics for a project
memory_forget             — delete a wrong/outdated memory by UUID
memory_slot_create/get/replace/list/delete — persistent named variables
memory_diagnose           — health check + row counts
memory_export             — full JSON snapshot of the DB
```
