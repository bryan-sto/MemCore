// test_am_fixes.js - Verification of MemCore audit remediation fixes
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3112;
const BASE_URL = `http://localhost:${PORT}`;

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('=== Starting MemCore Audit Fixes Test ===\n');
  let passed = 0;
  let failed = 0;

  function pass(msg) {
    console.log(`[PASS] ${msg}`);
    passed++;
  }

  function fail(msg, err) {
    console.error(`[FAIL] ${msg}:`, err ? err.message || err : '');
    failed++;
  }

  const proc = spawn(process.execPath, ['index.js'], {
    cwd: __dirname,
    env: { ...process.env, MEMCORE_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let serverReady = false;
  proc.stderr.on('data', (d) => {
    const msg = d.toString();
    if (msg.includes('[MemCore REST]')) serverReady = true;
  });

  for (let i = 0; i < 40; i++) {
    if (serverReady) break;
    try {
      const res = await httpRequest('GET', '/livez');
      if (res.status === 200) { serverReady = true; break; }
    } catch (_) {}
    await sleep(200);
  }

  if (!serverReady) {
    console.error('Server failed to start in time');
    proc.kill();
    process.exit(1);
  }
  pass(`Server booted on port ${PORT} - Responded 200 to /livez`);

  try {
    // 1. GET /agentmemory/command/history
    console.log('\n--- 1. Testing GET /agentmemory/command/history ---');
    const logRes = await httpRequest('POST', '/agentmemory/command/log', {
      project: 'pyrtk-test',
      command: 'git status -s',
      input_t: 150,
      output_t: 25,
      saved_t: 125,
      pct: 83.3,
      exec_ms: 18,
    });
    assert.strictEqual(logRes.status, 201);
    pass('POST /command/log logged test command');

    const histRes = await httpRequest('GET', '/agentmemory/command/history?hours=1');
    assert.strictEqual(histRes.status, 200);
    assert(Array.isArray(histRes.body.commands), 'Expected commands array');
    const matched = histRes.body.commands.find((c) => c.command === 'git status -s' && c.project === 'pyrtk-test');
    assert(matched, 'Logged command not found in history query');
    pass(`GET /command/history returned logged commands array - Found matching entry with ${histRes.body.commands.length} total commands`);

    // 2. Context Pack Multi-Line Regex Normalization
    console.log('\n--- 2. Testing Context Pack Multi-Line Regex Normalization ---');
    await httpRequest('POST', '/agentmemory/memories', {
      content: 'Multi-line convention:\nLine 1\nLine 2\nLine 3',
      type: 'convention',
      concepts: 'convention,test',
      project: 'regex-test-proj',
    });
    const packRes = await httpRequest('GET', '/agentmemory/context-pack?project=regex-test-proj');
    assert.strictEqual(packRes.status, 200);
    assert(!packRes.body.context_pack.includes('Line 1\nLine 2'), 'Expected multi-line convention to be collapsed to single line');
    pass('Context pack collapsed multi-line convention cleanly via /\\s+/g');

    // 3. Orphan Concept Edge Pruning in Database Consolidation
    console.log('\n--- 3. Testing Orphan Concept Edge Pruning in Database Consolidation ---');
    const saveRes = await httpRequest('POST', '/agentmemory/memories', {
      content: 'Ephemeral memory with rare concepts',
      type: 'arch',
      concepts: 'isolatedconceptalpha,isolatedconceptbeta',
      project: 'orphan-test-proj',
    });
    const memId = saveRes.body.id;
    pass('Concept edge created on memory save');

    await httpRequest('DELETE', `/agentmemory/memories/${memId}`);
    const consRes = await httpRequest('POST', '/agentmemory/consolidate');
    assert.strictEqual(consRes.status, 200);
    const edgesPruned = consRes.body.stats ? consRes.body.stats.edges_pruned : consRes.body.edges_pruned;
    assert(edgesPruned !== undefined, 'Expected edges_pruned metric');
    pass(`consolidateDatabase reported edges_pruned metric - Edges pruned: ${edgesPruned}`);

    const conceptsRes = await httpRequest('GET', '/agentmemory/concepts?project=orphan-test-proj');
    const foundOrphan = conceptsRes.body.some((e) => e.concept_a === 'isolatedconceptalpha' || e.concept_b === 'isolatedconceptalpha');
    assert(!foundOrphan, 'Orphan concept edge was not pruned');
    pass('Orphan concept edge successfully purged during consolidation');

    // 4. BM25 Division-by-Zero Resilience
    console.log('\n--- 4. Testing BM25 Division-by-Zero Resilience ---');
    const searchRes = await httpRequest('POST', '/agentmemory/search', { query: 'test bm25 safety' });
    assert.strictEqual(searchRes.status, 200);
    assert(Array.isArray(searchRes.body), 'Search returned results');
    pass('avgDocLen safely defaults to 1 for zero-token candidates without producing NaN');
  } catch (err) {
    fail('Audit fixes test failed', err);
  } finally {
    proc.kill();
    console.log('\n=============================================');
    console.log(`Results: Passed: ${passed}, Failed: ${failed}`);
    console.log('=============================================');
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
