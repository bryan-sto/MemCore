#!/usr/bin/env node
/**
 * MemCore Auto-Capture Hook Script
 *
 * Reads a JSON hook payload from stdin, enriches it, and POSTs it to the
 * MemCore server at POST /agentmemory/hook.
 *
 * Compatible with:
 *   - Claude Code hook format (hooks in ~/.claude/settings.json)
 *   - Codex CLI hook format
 *   - Any stdio-based hook runner that sends JSON on stdin
 *   - Direct invocation: echo '{"event":"Manual","content":"..."}' | node auto-capture.js
 *
 * Environment variables:
 *   MEMCORE_PORT  — override default port 3111
 *   MEMCORE_EVENT — override event type (PostToolUse|UserPrompt|SessionStart|SessionEnd|Manual)
 *
 * Exit codes:
 *   0 — success (or gracefully skipped)
 *   1 — server unreachable or fatal error
 */

const http = require('http');

const PORT  = parseInt(process.env.MEMCORE_PORT || '3111', 10);
const EVENT = process.env.MEMCORE_EVENT || '';

function postToMemcore(payload) {
  const body = JSON.stringify(payload);
  const opts = {
    hostname: 'localhost',
    port:     PORT,
    path:     '/agentmemory/hook',
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };

  const req = http.request(opts, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      process.exit(0);
    });
  });

  req.on('error', err => {
    process.exit(0);
  });

  req.setTimeout(2000, () => { req.destroy(); process.exit(0); });
  req.write(body);
  req.end();
}

if (EVENT === 'SessionStart' || EVENT === 'SessionEnd' || EVENT === 'Stop') {
  postToMemcore({ event: EVENT });
} else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let payload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw.trim());
      } catch (_) {
        payload = { event: 'Manual', content: raw.trim() };
      }
    }

    if (EVENT) payload.event = EVENT;
    if (!payload.event) payload.event = 'Manual';

    if (payload.event === 'Manual' && !payload.content) {
      process.exit(0);
    }

    postToMemcore(payload);
  });
}

