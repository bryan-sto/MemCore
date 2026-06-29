/**
 * MemCore v3 - Lightweight SQLite-based local memory server for AI coding agents.
 *
 * v3 additions over v2:
 * - BM25 re-ranking: FTS5 candidates are re-scored with a proper BM25 formula so
 *   the most relevant result always surfaces first.
 * - Concept-graph expansion: queries automatically expand to related concepts that
 *   co-occur in existing memories, bridging synonym gaps without vector embeddings.
 * - Auto-capture hook endpoint (POST /agentmemory/hook): receives lifecycle events
 *   (PostToolUse, SessionStart, SessionEnd, UserPrompt) from any agent's hook system
 *   and automatically saves relevant observations.
 * - Auto-summarize on session end: extracts top concepts and key memories from the
 *   closing session and saves a compact session-summary memory for future recall.
 * - memory_session_summarize MCP tool: agents can trigger summarization explicitly.
 * - memory_hook MCP tool: allows piping hook payloads through MCP when no HTTP hook
 *   runner is available.
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const http     = require('http');
const crypto   = require('crypto');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');

// ─── 1. Config & Directories ─────────────────────────────────────────────────

const PORT        = parseInt(process.env.MEMCORE_PORT || '3111', 10);
const MEMCORE_DIR = 'D:\\Personal Project\\am';
const DB_PATH     = path.join(MEMCORE_DIR, 'db.sqlite');
const LOG_FILE    = path.join(MEMCORE_DIR, 'memcore.log');
const VERSION     = '3.0.0';

// Auto-capture filter: tool names containing these strings are ignored (too noisy)
const HOOK_IGNORE_TOOLS = new Set([
  'read_url_content', 'list_dir', 'list_permissions', 'manage_task',
  'manage_subagents', 'schedule',
]);

// Minimum content length to auto-save from a hook (avoid saving trivial results)
const HOOK_MIN_CONTENT_LEN = 80;

if (!fs.existsSync(MEMCORE_DIR)) {
  fs.mkdirSync(MEMCORE_DIR, { recursive: true });
}

// ─── 2. Logging ───────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const _origErr  = console.error;
console.error = function (...args) {
  const msg = args.map(a =>
    a instanceof Error ? a.stack : (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))
  ).join(' ');
  logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
  _origErr.apply(console, args);
};

console.error(`[MemCore v${VERSION}] Starting up. DB: ${DB_PATH}`);

// ─── 3. Database ──────────────────────────────────────────────────────────────

let db;
try {
  db = new DatabaseSync(DB_PATH);

  // WAL mode for concurrent reads; NORMAL sync is safe and fast with WAL
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous  = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA auto_vacuum  = INCREMENTAL;');
  db.exec('PRAGMA cache_size   = -8000;'); // 8 MB page cache

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      project    TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_obs_session   ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content    TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'observation',
      concepts   TEXT,
      files      TEXT,
      project    TEXT,
      timestamp  TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      embedding  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mem_project   ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_mem_timestamp ON memories(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_session   ON memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_mem_type      ON memories(type);
  `);

  // Ensure memories table has the confidence column for existing databases
  try {
    db.exec('ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 1.0;');
    console.error('[MemCore] Added confidence column to memories table.');
  } catch (_) {
    // Column already exists, safe to ignore
  }

  // Ensure memories table has the embedding column for existing databases
  try {
    db.exec('ALTER TABLE memories ADD COLUMN embedding TEXT;');
    console.error('[MemCore] Added embedding column to memories table.');
  } catch (_) {
    // Column already exists, safe to ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT UNIQUE NOT NULL,
      context    TEXT,
      confidence REAL DEFAULT 1.0,
      project    TEXT,
      tags       TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_project    ON lessons(project);
    CREATE INDEX IF NOT EXISTS idx_lessons_confidence ON lessons(confidence DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS slots (
      label       TEXT PRIMARY KEY,
      content     TEXT,
      size_limit  INTEGER DEFAULT 1048576,
      description TEXT,
      pinned      INTEGER DEFAULT 0,
      scope       TEXT DEFAULT 'global',
      updated_at  TEXT NOT NULL
    );
  `);

  // concept_edges: tracks which concepts co-occur in the same memory (for query expansion)
  db.exec(`
    CREATE TABLE IF NOT EXISTS concept_edges (
      concept_a  TEXT NOT NULL,
      concept_b  TEXT NOT NULL,
      weight     INTEGER DEFAULT 1,
      project    TEXT,
      PRIMARY KEY (concept_a, concept_b, project)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_a ON concept_edges(concept_a, project);
    CREATE INDEX IF NOT EXISTS idx_edges_b ON concept_edges(concept_b, project);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS command_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp    TEXT NOT NULL,
      project      TEXT NOT NULL,
      command      TEXT NOT NULL,
      input_t      INTEGER NOT NULL,
      output_t     INTEGER NOT NULL,
      saved_t      INTEGER NOT NULL,
      pct          REAL NOT NULL,
      exec_ms      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cmd_timestamp ON command_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_cmd_project ON command_logs(project);
  `);

  // FTS5 virtual tables
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts     USING fts5(content, concepts, files, content_id UNINDEXED);
      CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts      USING fts5(content, context, content_id UNINDEXED);
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(content, content_id UNINDEXED);
    `);
    console.error('[MemCore] FTS5 initialized.');
  } catch (ftsErr) {
    console.error('[MemCore] FTS5 unavailable; falling back to LIKE.', ftsErr.message);
  }
} catch (dbErr) {
  console.error('[MemCore] Fatal: could not open DB.', dbErr);
  process.exit(1);
}

// ─── 4. Session Bootstrap ─────────────────────────────────────────────────────

let currentSessionId = crypto.randomUUID();
const defaultProject = process.env.PROJECT_NAME || path.basename(process.cwd()) || 'default';
const defaultCwd     = process.cwd();

function resolveSessionId(sid, project = '', cwd = '') {
  if (sid) return sid;
  const targetProject = project || defaultProject;
  const targetCwd = cwd || defaultCwd;
  try {
    // 1. Try matching project and cwd first (best match)
    if (cwd) {
      const row = db.prepare('SELECT id FROM sessions WHERE project = ? AND cwd = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(targetProject, targetCwd);
      if (row) return row.id;
    }
    // 2. Fall back to matching active session by project name only (for MCP/REST calls omitting cwd)
    const rowProj = db.prepare('SELECT id FROM sessions WHERE project = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(targetProject);
    if (rowProj) return rowProj.id;

    // 3. Lazy session initialization: create project-specific session if none exists to prevent cross-project fallback
    const newId = crypto.randomUUID();
    const ts = new Date().toISOString();
    db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run(
      newId,
      targetProject,
      targetCwd,
      ts
    );
    console.error(`[MemCore] Auto-started new session for project: ${targetProject} (id: ${newId})`);
    return newId;
  } catch (err) {
    console.error('[MemCore] Error in resolveSessionId:', err.message);
  }
  return currentSessionId;
}

function bootstrapRESTSession() {
  try {
    const orphanTs = new Date().toISOString();
    const orphanResult = db.prepare(
      "UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL"
    ).run(orphanTs);
    if (orphanResult.changes > 0) {
      console.error(`[MemCore] Closed ${orphanResult.changes} orphaned session(s) from previous run(s).`);
    }

    const newId = crypto.randomUUID();
    const ts = new Date().toISOString();
    db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run(
      newId,
      defaultProject,
      defaultCwd,
      ts
    );
    currentSessionId = newId;
    console.error(`[MemCore] REST started session: ${currentSessionId} (project: ${defaultProject})`);
  } catch (e) {
    console.error('[MemCore] Error bootstrapping REST session:', e.message);
  }
}

function bootstrapMCPSession() {
  try {
    const row = db.prepare('SELECT id, project FROM sessions WHERE project = ? AND cwd = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(defaultProject, defaultCwd);
    if (row) {
      currentSessionId = row.id;
      console.error(`[MemCore] MCP connected to active session: ${currentSessionId} (project: ${row.project})`);
    } else {
      const newId = crypto.randomUUID();
      const ts = new Date().toISOString();
      db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run(
        newId,
        defaultProject,
        defaultCwd,
        ts
      );
      currentSessionId = newId;
      console.error(`[MemCore] MCP started new session: ${currentSessionId} (project: ${defaultProject})`);
    }
  } catch (e) {
    console.error('[MemCore] Error bootstrapping MCP session:', e.message);
  }
}

// ─── 5. Search Utilities: tokenise + BM25 + concept-graph expansion ───────────

let pipelineInstance = null;

/** Generate 384-dimensional normalized vector embedding via local Wasm Transformers.js */
async function getEmbedding(text) {
  if (!text) return null;
  try {
    if (!pipelineInstance) {
      let transformers;
      try {
        transformers = require('@xenova/transformers');
      } catch (e) {
        const fallbackPath = path.join(MEMCORE_DIR, 'node_modules', '@xenova', 'transformers');
        transformers = require(fallbackPath);
      }
      const { pipeline, env } = transformers;
      env.cacheDir = path.join(MEMCORE_DIR, '.cache');
      
      // Enable Multi-Threading and SIMD for high-speed crash-free execution on Node v24+
      env.backends.onnx.wasm.numThreads = 4;
      env.backends.onnx.wasm.simd = true;
      
      pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device: 'wasm' });
    }
    const output = await pipelineInstance(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch (err) {
    console.error('[MemCore] Embedding error:', err.message);
    return null;
  }
}

// Background pre-load and warm up the embedding model to avoid first-run latency
getEmbedding('warmup').then(() => {
  console.error('[MemCore] Local embedding pipeline pre-loaded and warmed up.');
}).catch((err) => {
  console.error('[MemCore] Local embedding pre-load failed:', err.message);
});

/** Extract alphabetic/numeric tokens from a query string. */
function tokenise(query) {
  return (query || '').match(/[a-zA-Z0-9\u00C0-\u017F]+/g) || [];
}

/**
 * BM25 re-ranker (pure JS, no external dependencies).
 *
 * Re-scores an array of candidate memory/lesson objects against the query tokens.
 * Parameters k1=1.5, b=0.75 are the widely-accepted defaults from the original paper.
 *
 * @param {object[]} candidates - Array of rows with at least a `content` field.
 * @param {string[]} tokens     - Tokenised query terms.
 * @param {string}   textField  - Field name to score against (default 'content').
 * @returns {object[]} Candidates sorted by BM25 score descending, each with `_bm25` attached.
 */
function bm25Rank(candidates, tokens, textField = 'content') {
  if (!candidates.length || !tokens.length) return candidates;

  // Corpus-level stats over the candidate set (approximation for speed)
  const docTokenCounts = candidates.map(c => tokenise(c[textField] || ''));
  const avgDocLen = docTokenCounts.reduce((s, t) => s + t.length, 0) / candidates.length;
  const N = candidates.length;

  // Document frequency per query token within the candidate set
  const df = {};
  for (const t of tokens) {
    const tl = t.toLowerCase();
    df[tl] = candidates.filter(c => (c[textField] || '').toLowerCase().includes(tl)).length;
  }

  // Score each candidate
  const scored = candidates.map((doc, i) => {
    const docTokens = docTokenCounts[i];
    const docLen    = docTokens.length;
    let score = 0;

    for (const t of tokens) {
      const tl  = t.toLowerCase();
      const tf  = docTokens.filter(dt => dt.toLowerCase() === tl).length;
      if (tf === 0) continue;
      const idf = Math.log((N - df[tl] + 0.5) / (df[tl] + 0.5) + 1);
      const k1  = 1.5, b = 0.75;
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen));
    }

    // Boost score if query tokens appear in concepts field (exact concept match = high signal)
    for (const t of tokens) {
      if ((doc.concepts || '').toLowerCase().includes(t.toLowerCase())) {
        score += 0.5;
      }
    }

    return { ...doc, _bm25: score };
  });

  return scored.sort((a, b) => b._bm25 - a._bm25);
}

/**
 * Concept-graph expansion: given query tokens, find related concepts that frequently
 * co-occur in existing memories. Returns expanded token set (original + related).
 *
 * This bridges synonym gaps — e.g. searching "database performance" will also find
 * memories tagged with "sql", "index", "query" if those concepts co-occur.
 */
function expandQueryConcepts(tokens, project = '', limit = 6) {
  if (!tokens.length) return tokens;
  const normProject = project || '';
  const expanded = new Set(tokens.map(t => t.toLowerCase()));

  try {
    for (const t of tokens) {
      const rows = normProject
        ? db.prepare(`
            SELECT concept_b AS c, weight FROM concept_edges WHERE concept_a = ? AND project = ?
            UNION ALL
            SELECT concept_a AS c, weight FROM concept_edges WHERE concept_b = ? AND project = ?
            ORDER BY weight DESC LIMIT ?
          `).all(t.toLowerCase(), normProject, t.toLowerCase(), normProject, limit)
        : db.prepare(`
            SELECT concept_b AS c, weight FROM concept_edges WHERE concept_a = ?
            UNION ALL
            SELECT concept_a AS c, weight FROM concept_edges WHERE concept_b = ?
            ORDER BY weight DESC LIMIT ?
          `).all(t.toLowerCase(), t.toLowerCase(), limit);
      rows.forEach(r => expanded.add(r.c));
    }
  } catch (_) {}

  return [...expanded];
}

/**
 * Update concept_edges when a memory is saved.
 * For every pair of concepts in the memory, increment their edge weight.
 */
function indexConceptEdges(conceptsStr, project) {
  const concepts = (conceptsStr || '')
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(Boolean);

  if (concepts.length < 2) return;
  const normProject = project || '';
  const ts = new Date().toISOString();

  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const [a, b] = [concepts[i], concepts[j]].sort();
      try {
        db.prepare(`
          INSERT INTO concept_edges (concept_a, concept_b, weight, project)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(concept_a, concept_b, project) DO UPDATE SET weight = weight + 1
        `).run(a, b, normProject);
      } catch (_) {}
    }
  }
}

// ─── 6. Core DB Functions ─────────────────────────────────────────────────────

/**
 * Save a memory, mirror to FTS5 + observations log, and index concept edges.
 */
async function saveMemory(content, type = 'observation', concepts = '', files = '', project = '') {
  const id           = crypto.randomUUID();
  const ts           = new Date().toISOString();
  const normConcepts = Array.isArray(concepts) ? concepts.join(',') : (concepts || '');
  const normFiles    = Array.isArray(files)    ? files.join(',')    : (files    || '');
  const normProject  = project || defaultProject;
  const sid          = resolveSessionId(null, normProject);

  console.error(`[DB CREATE] saveMemory id=${id} type=${type} project=${normProject} concepts="${normConcepts}" content="${content.slice(0, 60)}"`);

  // Generate embedding asynchronously
  const embedding = await getEmbedding(content);
  const embeddingStr = embedding ? JSON.stringify(embedding) : null;

  db.prepare(
    'INSERT INTO memories (id, session_id, content, type, concepts, files, project, timestamp, confidence, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?)'
  ).run(id, sid, content, type, normConcepts, normFiles, normProject, ts, embeddingStr);

  try {
    db.prepare(
      'INSERT INTO memories_fts (content, concepts, files, content_id) VALUES (?, ?, ?, ?)'
    ).run(content, normConcepts, normFiles, id);
  } catch (_) {}

  db.prepare(
    'INSERT INTO observations (session_id, type, content, timestamp) VALUES (?, ?, ?, ?)'
  ).run(sid, type, content, ts);

  // Index concept relationships for graph expansion
  indexConceptEdges(normConcepts, normProject);

  return { id, session_id: sid, content, type, concepts: normConcepts, files: normFiles, project: normProject, timestamp: ts, confidence: 1.0, embedding };
}

/** Delete a memory by ID. */
function deleteMemory(id) {
  console.error(`[DB DELETE] deleteMemory id=${id}`);
  const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
  if (!existing) return false;
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  try { db.prepare('DELETE FROM memories_fts WHERE content_id = ?').run(id); } catch (_) {}
  return true;
}

/** Calculate Cosine Similarity between two numerical vectors. */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Hybrid search: FTS5 → LIKE fallback ➔ Semantic Vector Cosine Similarity ➔ BM25 re-rank.
 *
 * Search pipeline:
 * 1. Expand query tokens via concept graph (adds related concepts as search terms)
 * 2. Try FTS5 MATCH (fast, handles stemming via wildcard prefix)
 * 3. Fall back to per-token LIKE intersection if FTS5 fails
 * 4. Fall back to recent project memories if candidate list is small to allow semantic vector matching
 * 5. Compute vector embedding of query and calculate Cosine Similarity against candidates
 * 6. Combine Vector Similarity and BM25 scores for final ranking
 * 7. Optionally trim to token_budget (approx chars / 4)
 */
async function searchMemories(query, limit = 5, project = '', tokenBudget = 0) {
  const normProject  = project || '';
  const rawTokens    = tokenise(query);
  const tokens       = expandQueryConcepts(rawTokens, normProject);
  console.error(`[DB READ] searchMemories query="${query}" expanded=[${tokens.join(',')}] project="${normProject}"`);

  // Generate query embedding asynchronously
  const queryVec = await getEmbedding(query);

  let results = [];

  // FTS5 attempt (use original tokens for FTS wildcard matching)
  try {
    const ftsQ = rawTokens.map(t => `${t}*`).join(' ');
    if (ftsQ) {
      results = normProject
        ? db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.content_id WHERE memories_fts MATCH ? AND m.project = ? LIMIT ?`).all(ftsQ, normProject, limit * 3)
        : db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.content_id WHERE memories_fts MATCH ? LIMIT ?`).all(ftsQ, limit * 3);
    }
  } catch (_) {}

  // LIKE fallback using expanded tokens
  if (results.length === 0 && tokens.length > 0) {
    const clauses = tokens.map(() => '(content LIKE ? OR concepts LIKE ? OR files LIKE ?)').join(' OR ');
    const params  = [];
    tokens.forEach(t => { const p = `%${t}%`; params.push(p, p, p); });
    if (normProject) params.push(normProject);
    params.push(limit * 3);
    results = db.prepare(`
      SELECT * FROM memories WHERE (${clauses}) ${normProject ? 'AND project = ?' : ''} ORDER BY timestamp DESC LIMIT ?
    `).all(...params);
  }

  // Fallback: if candidates are few, pull recent memories to enable semantic vector matches
  if (results.length < limit * 2) {
    const recentParams = [];
    if (normProject) recentParams.push(normProject);
    recentParams.push(100);
    const recent = db.prepare(`
      SELECT * FROM memories WHERE 1=1 ${normProject ? 'AND project = ?' : ''} ORDER BY timestamp DESC LIMIT ?
    `).all(...recentParams);

    const seen = new Set(results.map(r => r.id));
    recent.forEach(r => {
      if (!seen.has(r.id)) {
        results.push(r);
        seen.add(r.id);
      }
    });
  }

  // Calculate BM25 ranking
  const bm25Scored = bm25Rank(results, tokens);

  // Fuse with Cosine Similarity + recency
  const fusedScored = bm25Scored.map(doc => {
    let vectorScore = 0;
    if (queryVec && doc.embedding) {
      try {
        const docVec = JSON.parse(doc.embedding);
        vectorScore = cosineSimilarity(queryVec, docVec);
      } catch (_) {}
    }
    // Combined score: Cosine similarity is base semantic score, BM25 adds term frequency match boost
    const relevanceScore = vectorScore + (doc._bm25 ? Math.min(1.0, doc._bm25 * 0.1) : 0);

    // Recency weight: slow half-life (~180 days), floored at 0.5 so old memories
    // are deprioritized on ties but never fully buried — they're durable facts,
    // not chat messages.
    const ageMs = Date.now() - new Date(doc.timestamp).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyWeight = isNaN(ageDays) ? 1 : (0.5 + 0.5 * Math.pow(0.5, ageDays / 180));

    const finalScore = relevanceScore * recencyWeight;
    return { ...doc, _cosine: vectorScore, _recency: recencyWeight, score: finalScore };
  });

  // Sort by final fused score
  const ranked = fusedScored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Reinforce confidence for returned memories (neural-pathway style traversal)
  for (const r of ranked) {
    try {
      db.prepare('UPDATE memories SET confidence = MIN(1.0, confidence + 0.1) WHERE id = ?').run(r.id);
      r.confidence = Math.min(1.0, (r.confidence ?? 1.0) + 0.1);
    } catch (_) {}
  }

  // Token-budget trim (approximate: chars / 4 ≈ tokens)
  if (tokenBudget > 0) {
    let charCount = 0;
    const trimmed = [];
    for (const r of ranked) {
      charCount += (r.content || '').length;
      if (charCount > tokenBudget * 4) break;
      trimmed.push(r);
    }
    console.error(`[DB READ] searchMemories Fused ranked ${ranked.length}, budget-trimmed to ${trimmed.length}`);
    return trimmed;
  }

  console.error(`[DB READ] searchMemories Fused ranked ${ranked.length} results`);
  return ranked;
}

/** Save or reinforce a lesson (UPSERT by content uniqueness). */
function saveLesson(content, context = '', confidence = 1.0, project = '', tags = '') {
  const ts          = new Date().toISOString();
  const normProject = project || defaultProject;
  const normTags    = Array.isArray(tags) ? tags.join(',') : (tags || '');
  const inc         = Number(confidence) || 1.0;

  console.error(`[DB UPSERT] saveLesson project=${normProject} conf_inc=${inc} content="${content.slice(0, 60)}"`);

  try {
    db.prepare(
      'INSERT INTO lessons (content, context, confidence, project, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(content, context || '', inc, normProject, normTags, ts);
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    try { db.prepare('INSERT INTO lessons_fts (content, context, content_id) VALUES (?, ?, ?)').run(content, context || '', String(id)); } catch (_) {}
    console.error(`[DB CREATE] lesson id=${id}`);
    return { id, content, context: context || '', confidence: inc, project: normProject, tags: normTags, updated_at: ts };
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      db.prepare('UPDATE lessons SET confidence = confidence + ?, updated_at = ? WHERE content = ?').run(inc, ts, content);
      const updated = db.prepare('SELECT * FROM lessons WHERE content = ?').get(content);
      console.error(`[DB UPDATE] lesson reinforced. confidence=${updated.confidence}`);
      return updated;
    }
    throw err;
  }
}

/** Delete a lesson by ID. */
function deleteLesson(id) {
  const row = db.prepare('SELECT id FROM lessons WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
  try { db.prepare('DELETE FROM lessons_fts WHERE content_id = ?').run(String(id)); } catch (_) {}
  return true;
}

/** Hybrid BM25 search for lessons. */
function searchLessons(query, project = '', minConfidence = 0.0, limit = 5) {
  const normProject = project || '';
  const rawTokens   = tokenise(query);
  const tokens      = expandQueryConcepts(rawTokens, normProject);
  console.error(`[DB READ] searchLessons query="${query}" expanded=[${tokens.join(',')}]`);

  let results = [];
  try {
    const ftsQ = rawTokens.map(t => `${t}*`).join(' ');
    if (ftsQ) {
      results = normProject
        ? db.prepare(`SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.content_id WHERE lessons_fts MATCH ? AND l.project = ? AND l.confidence >= ? ORDER BY l.confidence DESC LIMIT ?`).all(ftsQ, normProject, minConfidence, limit * 3)
        : db.prepare(`SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.content_id WHERE lessons_fts MATCH ? AND l.confidence >= ? ORDER BY l.confidence DESC LIMIT ?`).all(ftsQ, minConfidence, limit * 3);
    }
  } catch (_) {}

  if (results.length === 0 && tokens.length > 0) {
    const cc = tokens.map(() => 'content LIKE ?').join(' OR ');
    const xc = tokens.map(() => 'context LIKE ?').join(' OR ');
    const params = [];
    tokens.forEach(t => params.push(`%${t}%`));
    tokens.forEach(t => params.push(`%${t}%`));
    if (normProject) params.push(normProject);
    params.push(minConfidence, limit * 3);
    results = db.prepare(`
      SELECT * FROM lessons WHERE ((${cc}) OR (${xc})) ${normProject ? 'AND project = ?' : ''} AND confidence >= ? ORDER BY confidence DESC LIMIT ?
    `).all(...params);
  }

  return bm25Rank(results, tokens).slice(0, limit);
}

/** Upsert slot content. Enforces size_limit. */
function replaceSlot(label, content) {
  const ts       = new Date().toISOString();
  const existing = db.prepare('SELECT size_limit FROM slots WHERE label = ?').get(label);
  const limit    = existing ? existing.size_limit : 1048576;
  if (Buffer.byteLength(content, 'utf8') > limit) {
    throw new Error(`Slot "${label}" content (${Buffer.byteLength(content, 'utf8')}B) exceeds size_limit (${limit}B).`);
  }
  db.prepare(`
    INSERT INTO slots (label, content, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(label, content, ts);
  return db.prepare('SELECT * FROM slots WHERE label = ?').get(label);
}

/** Append text to a slot. Enforces size_limit. */
function appendSlot(label, text) {
  const ts       = new Date().toISOString();
  const existing = db.prepare('SELECT content, size_limit FROM slots WHERE label = ?').get(label);
  const newContent = existing ? (existing.content + text) : text;
  const limit    = existing ? existing.size_limit : 1048576;
  if (Buffer.byteLength(newContent, 'utf8') > limit) {
    throw new Error(`Slot "${label}" would exceed size_limit (${limit}B) after append.`);
  }
  db.prepare(`
    INSERT INTO slots (label, content, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(label, newContent, ts);
  return db.prepare('SELECT * FROM slots WHERE label = ?').get(label);
}

/** Create a slot. Throws if label already exists. */
function createSlot(label, content = '', sizeLimit = 1048576, description = '', pinned = false, scope = 'global') {
  const ts = new Date().toISOString();
  db.prepare(
    'INSERT INTO slots (label, content, size_limit, description, pinned, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(label, content, sizeLimit, description, pinned ? 1 : 0, scope, ts);
  return db.prepare('SELECT * FROM slots WHERE label = ?').get(label);
}

/** Delete a slot by label. */
function deleteSlot(label) {
  const existing = db.prepare('SELECT label FROM slots WHERE label = ?').get(label);
  if (!existing) return false;
  db.prepare('DELETE FROM slots WHERE label = ?').run(label);
  return true;
}

/**
 * Auto-summarize a session.
 *
 * Extracts the top concepts and key memory snippets from the given session and saves
 * a compact session_summary memory. Runs without an LLM — purely extractive.
 *
 * @param {string} sessionId - The session to summarize. Defaults to currentSessionId.
 * @returns {object|null} The saved summary memory, or null if no memories exist.
 */
/**
 * Auto-summarize a session.
 *
 * Extracts the top concepts and key memory snippets from the given session and saves
 * a compact session_summary memory. Runs without an LLM — purely extractive.
 *
 * @param {string} sessionId - The session to summarize. Defaults to currentSessionId.
 * @returns {object|null} The saved summary memory, or null if no memories exist.
 */
async function summarizeSession(sessionId) {
  const sid = resolveSessionId(sessionId);
  console.error(`[AUTO-SUMMARIZE] Summarizing session ${sid}`);

  const memories = db.prepare(
    "SELECT content, concepts, type, timestamp FROM memories WHERE session_id = ? AND type != 'session_summary' ORDER BY timestamp ASC"
  ).all(sid);

  if (memories.length === 0) {
    console.error('[AUTO-SUMMARIZE] No memories to summarize.');
    return null;
  }

  // Count concept frequency across all memories in this session
  const conceptFreq = {};
  memories.forEach(m => {
    (m.concepts || '').split(',').forEach(c => {
      c = c.trim().toLowerCase();
      if (c) conceptFreq[c] = (conceptFreq[c] || 0) + 1;
    });
  });

  // Top 10 concepts by frequency
  const topConcepts = Object.entries(conceptFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k]) => k);

  // Count memory types
  const typeCounts = {};
  memories.forEach(m => { typeCounts[m.type] = (typeCounts[m.type] || 0) + 1; });
  const typeStr = Object.entries(typeCounts).map(([t, c]) => `${c} ${t}`).join(', ');

  // Key memory snippets (first sentence or first 120 chars of each top-5 memory)
  const keySnippets = memories
    .slice(-5)  // most recent 5
    .map(m => m.content.replace(/\s+/g, ' ').slice(0, 120).trim())
    .filter(Boolean);

  const project = db.prepare('SELECT project FROM sessions WHERE id = ?').get(sid)?.project || defaultProject;
  const date    = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const summaryContent =
    `[session_summary][${date}][${project}] ` +
    `${memories.length} memories (${typeStr}). ` +
    `Top concepts: ${topConcepts.join(', ') || 'general'}. ` +
    `Recent work: ${keySnippets.join(' | ')}`;

  console.error(`[AUTO-SUMMARIZE] Saving summary: "${summaryContent.slice(0, 80)}..."`);

  return await saveMemory(
    summaryContent,
    'session_summary',
    topConcepts.join(','),
    '',
    project
  );
}

/**
 * Process an auto-capture hook event.
 *
 * Decides whether an incoming lifecycle event is worth saving to memory.
 * Filters noisy/trivial events to avoid polluting the memory store.
 *
 * Supported events:
 *   PostToolUse   - tool_name, tool_args, tool_result (string)
 *   UserPrompt    - prompt (string)
 *   SessionStart  - project, cwd
 *   SessionEnd    - (triggers auto-summarize)
 *   Manual        - content (string), type, concepts, files, project
 */
async function processHookEvent(event, data = {}) {
  console.error(`[HOOK] Event: ${event}`);

  switch (event) {
    case 'PostToolUse': {
      const { tool_name = '', tool_args = {}, tool_result = '', project = '' } = data;

      // Skip ignored/noisy tools
      if (HOOK_IGNORE_TOOLS.has(tool_name)) {
        return { skipped: true, reason: 'tool in ignore list' };
      }
      const resultStr = typeof tool_result === 'string' ? tool_result : JSON.stringify(tool_result);
      if (resultStr.length < HOOK_MIN_CONTENT_LEN) {
        return { skipped: true, reason: 'result too short to be meaningful' };
      }

      // Truncate very long results (keep first 800 chars)
      const truncated = resultStr.length > 800
        ? resultStr.slice(0, 800) + '… [truncated]'
        : resultStr;

      const content  = `[hook:PostToolUse] Tool: ${tool_name}. Result: ${truncated}`;
      const concepts = [tool_name, ...Object.keys(tool_args || {}).slice(0, 3)].join(',');

      return await saveMemory(content, 'hook_observation', concepts, '', project);
    }

    case 'UserPrompt': {
      const { prompt = '', project = '' } = data;
      if (prompt.length < HOOK_MIN_CONTENT_LEN) return { skipped: true, reason: 'prompt too short' };
      return await saveMemory(
        `[hook:UserPrompt] ${prompt.slice(0, 600)}`,
        'user_prompt',
        '',
        '',
        project
      );
    }

    case 'SessionStart': {
      const { project = defaultProject, cwd = defaultCwd } = data;
      const newId = crypto.randomUUID();
      const ts    = new Date().toISOString();
      try {
        db.prepare('UPDATE sessions SET ended_at = ? WHERE project = ? AND cwd = ? AND ended_at IS NULL').run(ts, project, cwd);
      } catch (_) {}
      db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run(newId, project, cwd, ts);
      currentSessionId = newId;
      console.error(`[HOOK] New session: ${newId} (${project})`);
      return { sessionId: newId, project, cwd, started_at: ts };
    }

    case 'SessionEnd': {
      const ts = new Date().toISOString();
      const sid = resolveSessionId(null, data.project, data.cwd);
      db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(ts, sid);
      const summary = await summarizeSession(sid);
      return { status: 'ended', sessionId: sid, summary_id: summary?.id || null };
    }

    case 'Manual': {
      const { content, type = 'observation', concepts = '', files = '', project = '' } = data;
      if (!content) return { error: 'content required for Manual hook event' };
      return await saveMemory(content, type, concepts, files, project);
    }

    default:
      return { error: `Unknown hook event: ${event}` };
  }
}

/** Export full DB as a single JSON snapshot. */
function exportAll() {
  return {
    exported_at:   new Date().toISOString(),
    version:       VERSION,
    sessions:      db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all(),
    memories:      db.prepare('SELECT * FROM memories ORDER BY timestamp DESC').all(),
    observations:  db.prepare('SELECT * FROM observations ORDER BY timestamp DESC').all(),
    lessons:       db.prepare('SELECT * FROM lessons ORDER BY updated_at DESC').all(),
    slots:         db.prepare('SELECT * FROM slots ORDER BY label ASC').all(),
    concept_edges: db.prepare('SELECT * FROM concept_edges ORDER BY weight DESC LIMIT 500').all(),
    command_logs:  db.prepare('SELECT * FROM command_logs ORDER BY timestamp DESC').all()
  };
}

/** Import full DB from a JSON snapshot inside an ACID transaction. */
async function importAll(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid backup data format.');
  
  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec('DELETE FROM sessions;');
    db.exec('DELETE FROM memories;');
    db.exec('DELETE FROM observations;');
    db.exec('DELETE FROM lessons;');
    db.exec('DELETE FROM slots;');
    db.exec('DELETE FROM concept_edges;');
    db.exec('DELETE FROM command_logs;');
    
    try {
      db.exec('DELETE FROM memories_fts;');
      db.exec('DELETE FROM lessons_fts;');
      db.exec('DELETE FROM observations_fts;');
    } catch (_) {}
    
    const insertSession = db.prepare('INSERT INTO sessions (id, project, cwd, started_at, ended_at) VALUES (?, ?, ?, ?, ?)');
    const insertMemory = db.prepare('INSERT INTO memories (id, session_id, content, type, concepts, files, project, timestamp, confidence, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertObs = db.prepare('INSERT INTO observations (id, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)');
    const insertLesson = db.prepare('INSERT INTO lessons (id, content, context, confidence, project, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertSlot = db.prepare('INSERT INTO slots (label, content, size_limit, description, pinned, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertEdge = db.prepare('INSERT INTO concept_edges (concept_a, concept_b, weight, project) VALUES (?, ?, ?, ?)');
    const insertCmd = db.prepare('INSERT INTO command_logs (timestamp, project, command, input_t, output_t, saved_t, pct, exec_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    if (Array.isArray(data.sessions)) {
      for (const s of data.sessions) {
        insertSession.run(s.id, s.project, s.cwd, s.started_at, s.ended_at);
      }
    }
    
    if (Array.isArray(data.memories)) {
      for (const m of data.memories) {
        insertMemory.run(m.id, m.session_id, m.content, m.type, m.concepts, m.files, m.project, m.timestamp, m.confidence ?? 1.0, m.embedding);
        try {
          db.prepare('INSERT INTO memories_fts (content, concepts, files, content_id) VALUES (?, ?, ?, ?)')
            .run(m.content, m.concepts || '', m.files || '', m.id);
        } catch (_) {}
      }
    }

    if (Array.isArray(data.observations)) {
      for (const o of data.observations) {
        insertObs.run(o.id, o.session_id, o.type, o.content, o.timestamp);
        try {
          db.prepare('INSERT INTO observations_fts (content, content_id) VALUES (?, ?)')
            .run(o.content, String(o.id));
        } catch (_) {}
      }
    }

    if (Array.isArray(data.lessons)) {
      for (const l of data.lessons) {
        insertLesson.run(l.id, l.content, l.context, l.confidence ?? 1.0, l.project, l.tags, l.updated_at);
        try {
          db.prepare('INSERT INTO lessons_fts (content, context, content_id) VALUES (?, ?, ?)')
            .run(l.content, l.context || '', String(l.id));
        } catch (_) {}
      }
    }

    if (Array.isArray(data.slots)) {
      for (const s of data.slots) {
        insertSlot.run(s.label, s.content, s.size_limit ?? 1048576, s.description, s.pinned ?? 0, s.scope ?? 'global', s.updated_at);
      }
    }

    if (Array.isArray(data.concept_edges)) {
      for (const e of data.concept_edges) {
        insertEdge.run(e.concept_a, e.concept_b, e.weight ?? 1, e.project || '');
      }
    }

    if (Array.isArray(data.command_logs)) {
      for (const c of data.command_logs) {
        insertCmd.run(c.timestamp, c.project, c.command, c.input_t, c.output_t, c.saved_t, c.pct, c.exec_ms);
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Consolidate and decay memory database.
 * 
 * 1. Decays confidence for all memories based on their type.
 *    - hook_observation, user_prompt: decay by 15% (multiplier = 0.85)
 *    - regular observation: decay by 10% (multiplier = 0.90)
 *    - env, bug: decay by 5% (multiplier = 0.95)
 *    - arch, decision, convention, session_summary: decay by 2% (multiplier = 0.98)
 * 2. Decays confidence for lessons:
 *    - decay by 10% (multiplier = 0.90)
 * 3. Prunes memories with confidence < 0.2
 * 4. Prunes lessons with confidence < 0.3
 * 5. Compacts database space with incremental vacuum.
 */
function consolidateDatabase() {
  console.error('[DB CONSOLIDATE] Starting consolidation and decay.');
  db.exec('BEGIN TRANSACTION;');
  try {
    // 1. Decay memories
    const memories = db.prepare('SELECT id, type, confidence FROM memories').all();
    let memoriesDecayed = 0;
    let memoriesPruned = 0;

    for (const m of memories) {
      const currentConf = m.confidence ?? 1.0;
      let multiplier = 0.90; // default for observation
      
      if (m.type === 'hook_observation' || m.type === 'user_prompt') {
        multiplier = 0.85;
      } else if (m.type === 'env' || m.type === 'bug') {
        multiplier = 0.95;
      } else if (
        m.type === 'arch' || 
        m.type === 'decision' || 
        m.type === 'convention' || 
        m.type === 'session_summary'
      ) {
        multiplier = 0.98;
      }

      const newConf = currentConf * multiplier;

      if (newConf < 0.2) {
        // Prune memory
        db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
        try { db.prepare('DELETE FROM memories_fts WHERE content_id = ?').run(m.id); } catch (_) {}
        memoriesPruned++;
      } else {
        db.prepare('UPDATE memories SET confidence = ? WHERE id = ?').run(newConf, m.id);
        memoriesDecayed++;
      }
    }

    // 2. Decay lessons
    const lessons = db.prepare('SELECT id, confidence FROM lessons').all();
    let lessonsDecayed = 0;
    let lessonsPruned = 0;

    for (const l of lessons) {
      const currentConf = l.confidence ?? 1.0;
      const newConf = currentConf * 0.90; // lessons decay at 10% rate

      if (newConf < 0.3) {
        db.prepare('DELETE FROM lessons WHERE id = ?').run(l.id);
        try { db.prepare('DELETE FROM lessons_fts WHERE content_id = ?').run(String(l.id)); } catch (_) {}
        lessonsPruned++;
      } else {
        db.prepare('UPDATE lessons SET confidence = ? WHERE id = ?').run(newConf, l.id);
        lessonsDecayed++;
      }
    }

    // 3. Compact database
    db.exec('PRAGMA incremental_vacuum(100);');

    db.exec('COMMIT;');
    console.error(`[DB CONSOLIDATE] Done. Memories decayed: ${memoriesDecayed}, pruned: ${memoriesPruned}. Lessons decayed: ${lessonsDecayed}, pruned: ${lessonsPruned}.`);

    return {
      status: 'ok',
      message: 'Consolidation and decay completed.',
      stats: {
        memories_decayed: memoriesDecayed,
        memories_pruned: memoriesPruned,
        lessons_decayed: lessonsDecayed,
        lessons_pruned: lessonsPruned,
      }
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

// ─── 7. HTTP Router ────────────────────────────────────────────────────────────

async function routeHttpRequest(url, method, body, sendJson) {
  const parsedUrl    = new URL(url, 'http://localhost');
  const pathName     = parsedUrl.pathname;
  const projectParam = parsedUrl.searchParams.get('project') || '';

  // GET /agentmemory/livez
  if (pathName === '/agentmemory/livez') {
    sendJson(200, { status: 'ok', service: 'memcore', version: VERSION, session: currentSessionId });
    return;
  }

  // GET /agentmemory/diagnostics | /stats
  if (pathName === '/agentmemory/diagnostics' || pathName === '/agentmemory/stats') {
    sendJson(200, {
      active_session:    resolveSessionId(null, projectParam),
      active_sessions:   db.prepare("SELECT count(*) as c FROM sessions WHERE ended_at IS NULL").get().c,
      total_sessions:    db.prepare('SELECT count(*) as c FROM sessions').get().c,
      sessions:          db.prepare('SELECT count(*) as c FROM sessions').get().c, // legacy fallback
      memories:          db.prepare('SELECT count(*) as c FROM memories').get().c,
      observations:      db.prepare('SELECT count(*) as c FROM observations').get().c,
      lessons:           db.prepare('SELECT count(*) as c FROM lessons').get().c,
      slots:             db.prepare('SELECT count(*) as c FROM slots').get().c,
      concept_edges:     db.prepare('SELECT count(*) as c FROM concept_edges').get().c,
    });
    return;
  }

  // GET /agentmemory/export
  if (pathName === '/agentmemory/export' && method === 'GET') {
    sendJson(200, exportAll());
    return;
  }

  // POST /agentmemory/import
  if (pathName === '/agentmemory/import' && method === 'POST') {
    try {
      await importAll(body);
      sendJson(200, { success: true, message: 'Database imported successfully.' });
    } catch (err) {
      console.error('[MemCore Import Error]', err);
      sendJson(500, { error: err.message });
    }
    return;
  }

  // GET /agentmemory/memories
  if (pathName === '/agentmemory/memories' && method === 'GET') {
    const lim  = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
    const list = projectParam
      ? db.prepare('SELECT * FROM memories WHERE project = ? ORDER BY timestamp DESC LIMIT ?').all(projectParam, lim)
      : db.prepare('SELECT * FROM memories ORDER BY timestamp DESC LIMIT ?').all(lim);
    sendJson(200, list);
    return;
  }

  // DELETE /agentmemory/memories/:id
  const memDeleteMatch = pathName.match(/^\/agentmemory\/memories\/([^/]+)$/);
  if (memDeleteMatch && method === 'DELETE') {
    const deleted = deleteMemory(memDeleteMatch[1]);
    sendJson(deleted ? 200 : 404, { success: deleted, id: memDeleteMatch[1] });
    return;
  }

  // GET /agentmemory/observations
  if (pathName === '/agentmemory/observations' && method === 'GET') {
    const lim  = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
    const list = projectParam
      ? db.prepare('SELECT o.* FROM observations o JOIN sessions s ON s.id = o.session_id WHERE s.project = ? ORDER BY o.timestamp DESC LIMIT ?').all(projectParam, lim)
      : db.prepare('SELECT * FROM observations ORDER BY timestamp DESC LIMIT ?').all(lim);
    sendJson(200, list);
    return;
  }

  // GET /agentmemory/sessions
  if (pathName === '/agentmemory/sessions' && method === 'GET') {
    sendJson(200, db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all());
    return;
  }

  // POST /agentmemory/session/start
  if (pathName === '/agentmemory/session/start' && method === 'POST') {
    const newId = crypto.randomUUID();
    const proj  = body.project || defaultProject;
    const cwd   = body.cwd    || defaultCwd;
    const ts    = new Date().toISOString();
    try {
      db.prepare('UPDATE sessions SET ended_at = ? WHERE project = ? AND cwd = ? AND ended_at IS NULL').run(ts, proj, cwd);
    } catch (_) {}
    db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run(newId, proj, cwd, ts);
    currentSessionId = newId;
    sendJson(201, { sessionId: newId, project: proj, cwd });
    return;
  }

  // POST /agentmemory/session/end
  if (pathName === '/agentmemory/session/end' && method === 'POST') {
    const ts = new Date().toISOString();
    const sid = resolveSessionId(body.session_id, body.project, body.cwd);
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(ts, sid);
    const summary = body.summarize !== false ? await summarizeSession(sid) : null;
    sendJson(200, { status: 'ended', sessionId: sid, summary_id: summary?.id || null });
    return;
  }

  // POST /agentmemory/hook  ← auto-capture from agent lifecycle hooks
  if (pathName === '/agentmemory/hook' && method === 'POST') {
    if (!body.event) { sendJson(400, { error: "Missing 'event' field" }); return; }
    try {
      const result = await processHookEvent(body.event, body);
      sendJson(200, result);
    } catch (e) { sendJson(500, { error: e.message }); }
    return;
  }

  // POST /agentmemory/session/summarize
  if (pathName === '/agentmemory/session/summarize' && method === 'POST') {
    const sid = resolveSessionId(body.session_id, body.project, body.cwd);
    const summary = await summarizeSession(sid);
    sendJson(200, summary || { message: 'No memories to summarize' });
    return;
  }

  // POST /agentmemory/remember
  if (pathName === '/agentmemory/remember' && method === 'POST') {
    if (!body.content) { sendJson(400, { error: "Missing 'content'" }); return; }
    sendJson(201, await saveMemory(body.content, body.type, body.concepts, body.files, body.project));
    return;
  }

  // POST /agentmemory/smart-search | /agentmemory/search
  if ((pathName === '/agentmemory/smart-search' || pathName === '/agentmemory/search') && method === 'POST') {
    if (!body.query) { sendJson(400, { error: "Missing 'query'" }); return; }
    sendJson(200, await searchMemories(body.query, body.limit || 5, body.project, body.token_budget || 0));
    return;
  }

  // GET|POST /agentmemory/lessons
  if (pathName === '/agentmemory/lessons') {
    if (method === 'POST') {
      if (!body.content) { sendJson(400, { error: "Missing 'content'" }); return; }
      sendJson(201, saveLesson(body.content, body.context, body.confidence, body.project, body.tags));
    } else {
      sendJson(200, db.prepare('SELECT * FROM lessons ORDER BY confidence DESC, updated_at DESC').all());
    }
    return;
  }

  // DELETE /agentmemory/lessons/:id
  const lessonDeleteMatch = pathName.match(/^\/agentmemory\/lessons\/([^/]+)$/);
  if (lessonDeleteMatch && method === 'DELETE') {
    const deleted = deleteLesson(parseInt(lessonDeleteMatch[1], 10));
    sendJson(deleted ? 200 : 404, { success: deleted, id: lessonDeleteMatch[1] });
    return;
  }

  // POST /agentmemory/lessons/search
  if (pathName === '/agentmemory/lessons/search' && method === 'POST') {
    if (!body.query) { sendJson(400, { error: "Missing 'query'" }); return; }
    sendJson(200, searchLessons(body.query, body.project, body.minConfidence || 0.0, body.limit || 5));
    return;
  }

  // GET /agentmemory/slots
  if ((pathName === '/agentmemory/slots' || pathName === '/agentmemory/slot') && method === 'GET') {
    sendJson(200, db.prepare('SELECT * FROM slots ORDER BY pinned DESC, label ASC').all());
    return;
  }

  // POST /agentmemory/slot/create
  if (pathName === '/agentmemory/slot/create' && method === 'POST') {
    if (!body.label) { sendJson(400, { error: "Missing 'label'" }); return; }
    try { sendJson(201, createSlot(body.label, body.content, body.sizeLimit, body.description, body.pinned, body.scope)); }
    catch (e) { sendJson(409, { error: e.message }); }
    return;
  }

  // POST /agentmemory/slot/replace
  if (pathName === '/agentmemory/slot/replace' && method === 'POST') {
    if (!body.label || body.content === undefined) { sendJson(400, { error: "Missing 'label' or 'content'" }); return; }
    try { sendJson(200, replaceSlot(body.label, body.content)); }
    catch (e) { sendJson(413, { error: e.message }); }
    return;
  }

  // POST /agentmemory/slot/append
  if (pathName === '/agentmemory/slot/append' && method === 'POST') {
    if (!body.label || !body.text) { sendJson(400, { error: "Missing 'label' or 'text'" }); return; }
    try { sendJson(200, appendSlot(body.label, body.text)); }
    catch (e) { sendJson(413, { error: e.message }); }
    return;
  }

  // DELETE /agentmemory/slot/:label
  const slotDeleteMatch = pathName.match(/^\/agentmemory\/slot\/([^/]+)$/);
  if (slotDeleteMatch && method === 'DELETE') {
    sendJson(deleteSlot(decodeURIComponent(slotDeleteMatch[1])) ? 200 : 404,
      { success: true, label: slotDeleteMatch[1] });
    return;
  }

  // GET /agentmemory/concepts  — inspect the concept graph
  if (pathName === '/agentmemory/concepts' && method === 'GET') {
    const lim  = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
    const list = projectParam
      ? db.prepare('SELECT * FROM concept_edges WHERE project = ? ORDER BY weight DESC LIMIT ?').all(projectParam, lim)
      : db.prepare('SELECT * FROM concept_edges ORDER BY weight DESC LIMIT ?').all(lim);
    sendJson(200, list);
    return;
  }

  // POST /agentmemory/consolidate | POST /agentmemory/vacuum
  if ((pathName === '/agentmemory/consolidate' || pathName === '/agentmemory/vacuum') && method === 'POST') {
    sendJson(200, consolidateDatabase());
    return;
  }

  // POST /agentmemory/command/log
  if (pathName === '/agentmemory/command/log' && method === 'POST') {
    const { timestamp, project, command, input_t, output_t, saved_t, pct, exec_ms } = body;
    if (!project || !command || input_t === undefined || output_t === undefined) {
      sendJson(400, { error: 'Missing required command log fields' });
      return;
    }
    const stmt = db.prepare(`
      INSERT INTO command_logs (timestamp, project, command, input_t, output_t, saved_t, pct, exec_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(timestamp || new Date().toISOString(), project, command, input_t, output_t, saved_t, pct, exec_ms);
    sendJson(201, { success: true });
    return;
  }

  // GET /agentmemory/gain
  if (pathName === '/agentmemory/gain' && method === 'GET') {
    const totalRow = db.prepare(`
      SELECT 
        COUNT(*) as total_commands,
        SUM(input_t) as total_input_t,
        SUM(output_t) as total_output_t,
        SUM(saved_t) as total_saved_t,
        AVG(pct) as avg_pct
      FROM command_logs
    `).get();
    
    const recentLogs = db.prepare(`
      SELECT * FROM command_logs ORDER BY timestamp DESC LIMIT 50
    `).all();
    
    const stats = {
      total_commands: totalRow.total_commands || 0,
      total_input_t: totalRow.total_input_t || 0,
      total_output_t: totalRow.total_output_t || 0,
      total_saved_t: totalRow.total_saved_t || 0,
      avg_pct: totalRow.avg_pct || 0.0,
      recent_logs: recentLogs
    };
    sendJson(200, stats);
    return;
  }

  // DELETE /agentmemory/command/logs
  if (pathName === '/agentmemory/command/logs' && method === 'DELETE') {
    db.prepare('DELETE FROM command_logs').run();
    sendJson(200, { success: true });
    return;
  }

  sendJson(404, { error: `Endpoint '${pathName}' [${method}] not found in MemCore v${VERSION}` });
}

// ─── 8. HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const sendJson = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const parsedUrl = new URL(req.url, 'http://localhost');

  // Static dashboard
  if (req.method === 'GET' && ['/', '/viewer', '/viewer/'].includes(parsedUrl.pathname)) {
    const htmlPath = path.join(__dirname, 'viewer.html');
    fs.readFile(htmlPath, 'utf8', (err, data) => {
      if (err) { res.writeHead(500); res.end(`viewer.html missing: ${err.message}`); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (!req.url.startsWith('/agentmemory')) { sendJson(404, { error: 'Not Found' }); return; }

  let rawBody = '';
  req.on('data', chunk => rawBody += chunk);
  req.on('end', async () => {
    let body = {};
    if (rawBody) {
      try { body = JSON.parse(rawBody); }
      catch { sendJson(400, { error: 'Invalid JSON body' }); return; }
    }
    try { await routeHttpRequest(req.url, req.method, body, sendJson); }
    catch (err) {
      console.error('[MemCore HTTP Error]', err);
      sendJson(500, { error: err.message });
    }
  });
});

server.listen(PORT, () => {
  console.error(`[MemCore REST] http://localhost:${PORT}`);
  bootstrapRESTSession();

  // Automate memory decay/consolidation in the background every 6 hours
  setInterval(() => {
    try {
      consolidateDatabase();
    } catch (err) {
      console.error('[MemCore Auto-Consolidate Error]', err.message);
    }
  }, 6 * 60 * 60 * 1000).unref();
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[MemCore] Port ${PORT} in use — MCP-only mode.`);
    bootstrapMCPSession();
  } else {
    console.error('[MemCore] HTTP error:', err);
  }
});

// ─── 9. MCP Tool Registry ──────────────────────────────────────────────────────

const toolsRegistry = [
  {
    name: 'memory_save',
    description: 'Save an important insight, decision, bug, or pattern to long-term memory.',
    inputSchema: {
      type: 'object',
      properties: {
        content:  { type: 'string', description: 'The insight or decision text to save.' },
        type:     { type: 'string', description: 'Memory type: observation | decision | bug | convention | arch | env' },
        concepts: { type: 'string', description: 'Comma-separated concept tags for search and graph expansion.' },
        files:    { type: 'string', description: 'Comma-separated relative file paths referenced.' },
        project:  { type: 'string', description: 'Project name. Defaults to cwd folder name.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_smart_search',
    description: 'Hybrid search: FTS5 + BM25 re-ranking + concept-graph expansion. Finds memories even when query words differ from saved terms.',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Search query text.' },
        project: { type: 'string', description: 'Restrict to this project.' },
        limit:   { type: 'number', description: 'Max results (default 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Recall past session observations. Supports token_budget to stay within context limits.',
    inputSchema: {
      type: 'object',
      properties: {
        query:        { type: 'string', description: 'Topic to recall.' },
        limit:        { type: 'number', description: 'Max results (default 10).' },
        project:      { type: 'string', description: 'Filter by project.' },
        token_budget: { type: 'number', description: 'Approx token cap; trims results to fit.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_forget',
    description: 'Delete a specific memory by its UUID. Use when a saved memory is wrong or outdated.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'UUID of the memory to delete.' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_sessions',
    description: 'List all session metadata (IDs, projects, timestamps, cwd).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_lesson_save',
    description: 'Save a lesson learned. Repeated saves of the same lesson increase its confidence score.',
    inputSchema: {
      type: 'object',
      properties: {
        content:    { type: 'string', description: 'The lesson text.' },
        context:    { type: 'string', description: 'Code snippet or scenario context.' },
        confidence: { type: 'number', description: 'Confidence increment (default 1.0).' },
        project:    { type: 'string', description: 'Project name.' },
        tags:       { type: 'string', description: 'Comma-separated tags.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_lesson_recall',
    description: 'Search lessons by topic. Uses BM25 + concept expansion. Returns by confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        query:         { type: 'string', description: 'Topic to search.' },
        project:       { type: 'string', description: 'Filter by project.' },
        minConfidence: { type: 'number', description: 'Minimum confidence threshold.' },
        limit:         { type: 'number', description: 'Max results.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_lesson_delete',
    description: 'Delete a lesson by its numeric ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Numeric ID of the lesson.' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_slot_create',
    description: 'Create a persistent named memory slot with optional size limit.',
    inputSchema: {
      type: 'object',
      properties: {
        label:       { type: 'string',  description: 'Slot name (key).' },
        content:     { type: 'string',  description: 'Initial content.' },
        sizeLimit:   { type: 'number',  description: 'Max bytes (default 1MB).' },
        description: { type: 'string',  description: 'Human-readable description.' },
        pinned:      { type: 'boolean', description: 'Pin to top of list.' },
        scope:       { type: 'string',  description: "'global' or 'project'." },
      },
      required: ['label'],
    },
  },
  {
    name: 'memory_slot_get',
    description: 'Read a single memory slot by label.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    },
  },
  {
    name: 'memory_slot_replace',
    description: 'Overwrite a slot with new content. Enforces the slot size limit.',
    inputSchema: {
      type: 'object',
      properties: {
        label:   { type: 'string', description: 'Slot label.' },
        content: { type: 'string', description: 'New content.' },
      },
      required: ['label', 'content'],
    },
  },
  {
    name: 'memory_slot_list',
    description: 'List all memory slots (pinned first).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_slot_delete',
    description: 'Delete a memory slot permanently.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    },
  },
  {
    name: 'memory_consolidate',
    description: 'Runs incremental DB vacuum to compact deleted space.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_diagnose',
    description: 'Returns row counts across all tables plus DB health info.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_reflect',
    description: 'Summarises memory count and top concepts for a project via the concept graph.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
    },
  },
  {
    name: 'memory_export',
    description: 'Export full database (memories, lessons, slots, concept graph) as a JSON snapshot.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_session_summarize',
    description: 'Auto-summarize the current (or specified) session into a compact session_summary memory. Call at end of session for best recall in future sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session to summarize. Defaults to current session.' },
      },
    },
  },
  {
    name: 'memory_hook',
    description: 'Fire a lifecycle hook event through MCP (use when no HTTP hook runner is available). Events: PostToolUse | UserPrompt | SessionStart | SessionEnd | Manual.',
    inputSchema: {
      type: 'object',
      properties: {
        event:       { type: 'string', description: 'Hook event name.' },
        tool_name:   { type: 'string', description: 'For PostToolUse: the tool that ran.' },
        tool_result: { type: 'string', description: 'For PostToolUse: the result text.' },
        tool_args:   { type: 'object', description: 'For PostToolUse: the arguments.' },
        prompt:      { type: 'string', description: 'For UserPrompt: the prompt text.' },
        content:     { type: 'string', description: 'For Manual: the content to save.' },
        type:        { type: 'string', description: 'For Manual: memory type.' },
        concepts:    { type: 'string', description: 'For Manual: concept tags.' },
        project:     { type: 'string', description: 'Project name.' },
      },
      required: ['event'],
    },
  },
];

// ─── 10. MCP Tool Executor ─────────────────────────────────────────────────────

async function executeMcpTool(name, args) {
  console.error(`[MCP] ${name}`);
  switch (name) {
    case 'memory_save':
      return await saveMemory(args.content, args.type, args.concepts, args.files, args.project);
    case 'memory_smart_search':
      return await searchMemories(args.query, args.limit || 5, args.project, 0);
    case 'memory_recall':
      return await searchMemories(args.query, args.limit || 10, args.project, args.token_budget || 0);
    case 'memory_forget':
      return { success: deleteMemory(args.id), id: args.id };
    case 'memory_sessions':
      return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();
    case 'memory_lesson_save':
      return saveLesson(args.content, args.context, args.confidence, args.project, args.tags);
    case 'memory_lesson_recall':
      return searchLessons(args.query, args.project, args.minConfidence || 0.0, args.limit || 5);
    case 'memory_lesson_delete':
      return { success: deleteLesson(args.id), id: args.id };
    case 'memory_slot_create':
      return createSlot(args.label, args.content, args.sizeLimit, args.description, args.pinned, args.scope);
    case 'memory_slot_get': {
      const s = db.prepare('SELECT * FROM slots WHERE label = ?').get(args.label);
      return s || { error: `Slot '${args.label}' not found.` };
    }
    case 'memory_slot_replace':
      return replaceSlot(args.label, args.content);
    case 'memory_slot_list':
      return db.prepare('SELECT * FROM slots ORDER BY pinned DESC, label ASC').all();
    case 'memory_slot_delete':
      return { success: deleteSlot(args.label), label: args.label };
    case 'memory_consolidate':
      return consolidateDatabase();
    case 'memory_diagnose':
      return {
        status:  'healthy',
        version: VERSION,
        active_session: resolveSessionId(null, args.project),
        stats: {
          active_sessions: db.prepare("SELECT count(*) as c FROM sessions WHERE ended_at IS NULL").get().c,
          total_sessions:  db.prepare('SELECT count(*) as c FROM sessions').get().c,
          sessions:        db.prepare('SELECT count(*) as c FROM sessions').get().c, // legacy fallback
          memories:        db.prepare('SELECT count(*) as c FROM memories').get().c,
          observations:    db.prepare('SELECT count(*) as c FROM observations').get().c,
          lessons:         db.prepare('SELECT count(*) as c FROM lessons').get().c,
          slots:           db.prepare('SELECT count(*) as c FROM slots').get().c,
          concept_edges:   db.prepare('SELECT count(*) as c FROM concept_edges').get().c,
        },
      };
    case 'memory_reflect': {
      const proj  = args.project || defaultProject;
      const count = db.prepare('SELECT count(*) as c FROM memories WHERE project = ?').get(proj).c;
      const edges = db.prepare('SELECT concept_a, concept_b, weight FROM concept_edges WHERE project = ? ORDER BY weight DESC LIMIT 15').all(proj);
      const freq  = {};
      edges.forEach(e => { freq[e.concept_a] = (freq[e.concept_a] || 0) + e.weight; freq[e.concept_b] = (freq[e.concept_b] || 0) + e.weight; });
      const topConcepts = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
      return { project: proj, memory_count: count, top_concepts: topConcepts, concept_edges: edges.length, message: `${count} memories in ${proj}. Graph top concepts: ${topConcepts.join(', ')}` };
    }
    case 'memory_export':
      return exportAll();
    case 'memory_session_summarize': {
      const sid = resolveSessionId(args.session_id, args.project);
      const summary = await summarizeSession(sid);
      return summary || { message: 'No memories to summarize for this session.' };
    }
    case 'memory_hook':
      return await processHookEvent(args.event, args);
    default:
      throw new Error(`Unknown tool: '${name}'`);
  }
}

// ─── 11. MCP JSON-RPC Stdio ────────────────────────────────────────────────────

async function handleMcpRequest(req) {
  const { method, params, id } = req;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'memcore', version: VERSION },
    }};
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: toolsRegistry } };
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await executeMcpTool(name, args || {});
      return { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }};
    } catch (err) {
      return { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      }};
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return null;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', async line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const response = await handleMcpRequest(JSON.parse(trimmed));
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  } catch (err) {
    console.error('[MCP parse error]', err.message);
  }
});

// ─── 12. Graceful Shutdown ─────────────────────────────────────────────────────

async function shutdown(signal) {
  console.error(`[MemCore] ${signal} — auto-summarizing and closing.`);
  try {
    const sid = resolveSessionId();
    // Auto-summarize the current session before closing
    await summarizeSession(sid);
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
      .run(new Date().toISOString(), sid);
  } catch (_) {}
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));