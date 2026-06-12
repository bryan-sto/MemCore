/**
 * MemCore v3 Performance Benchmark
 *
 * Measures:
 *   1. Write throughput (200 sequential saves)
 *   2. BM25 search throughput (100 queries)
 *   3. Concept-expansion search throughput (50 queries)
 *   4. Lesson reinforcement (10 saves, confidence accumulation)
 *   5. Slot chain (create → append → get → delete)
 *   6. Hook throughput (50 PostToolUse events)
 *   7. p50/p95/p99 latency percentiles for search
 *
 * Assumes the MemCore server is already running on port 3111.
 * Start it first: node index.js
 */

const PORT     = 3111;
const BASE_URL = `http://localhost:${PORT}/agentmemory`;

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const CYAN  = '\x1b[36m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const YELLOW = '\x1b[33m';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p / 100)]?.toFixed(2) ?? 'n/a';
}

function row(label, value) {
  const pad = 28;
  console.log(` ${CYAN}${label.padEnd(pad)}${RESET} ${value}`);
}

async function post(path, body) {
  const t0 = performance.now();
  const r  = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - t0;
  return { data: await r.json(), ms };
}

async function get(path) {
  const t0 = performance.now();
  const r  = await fetch(`${BASE_URL}${path}`);
  const ms = performance.now() - t0;
  return { data: await r.json(), ms };
}

async function runBenchmark() {
  console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════════╗`);
  console.log(`║       MEMCORE v3 PERFORMANCE BENCHMARK       ║`);
  console.log(`╚══════════════════════════════════════════════╝${RESET}\n`);

  // Liveness check
  try {
    const { data } = await get('/livez');
    if (data.status !== 'ok') throw new Error('unhealthy');
    console.log(`${GREEN}Server online: MemCore v${data.version}${RESET}\n`);
  } catch {
    console.error('Cannot reach MemCore on port 3111. Start it with: node index.js');
    process.exit(1);
  }

  const project = 'benchmark-v3';

  // ── 1. Write Benchmark ───────────────────────────────────────────────────────
  console.log(`${BOLD}1. Write Throughput (200 sequential saves)${RESET}`);
  const writeTimes = [];
  for (let i = 1; i <= 200; i++) {
    const { ms } = await post('/remember', {
      content:  `Benchmark observation ${i}: system performance analysis for project-${i % 10}.`,
      concepts: `benchmark,performance,observation,batch-${Math.ceil(i/50)}`,
      project,
      type: 'benchmark',
    });
    writeTimes.push(ms);
  }
  const writeTotalMs = writeTimes.reduce((s, t) => s + t, 0);
  console.log(`   200 writes in ${writeTotalMs.toFixed(0)}ms`);
  row('Avg write latency', `${(writeTotalMs / 200).toFixed(2)}ms`);
  row('p50 write', `${pct(writeTimes, 50)}ms`);
  row('p95 write', `${pct(writeTimes, 95)}ms`);
  row('p99 write', `${pct(writeTimes, 99)}ms`);
  row('Write throughput', `${(200 / (writeTotalMs / 1000)).toFixed(1)} writes/sec`);

  // ── 2. BM25 Search Benchmark ─────────────────────────────────────────────────
  console.log(`\n${BOLD}2. BM25 Search Throughput (100 queries)${RESET}`);
  const searchQueries = [
    'performance', 'observation', 'project optimization',
    'system analysis', 'benchmark batch', 'observation batch-2',
    'performance batch-4', 'system project', 'analysis performance',
    'batch performance observation',
  ];
  const searchTimes = [];
  let searchResultCount = 0;
  for (let i = 0; i < 100; i++) {
    const q = searchQueries[i % searchQueries.length];
    const { data, ms } = await post('/smart-search', { query: q, limit: 5, project });
    searchTimes.push(ms);
    searchResultCount += data.length;
    if (data.length === 0) process.stdout.write(`${YELLOW}!${RESET}`);
  }
  const searchTotalMs = searchTimes.reduce((s, t) => s + t, 0);
  console.log(`   100 searches in ${searchTotalMs.toFixed(0)}ms (avg results=${(searchResultCount/100).toFixed(1)})`);
  row('Avg search latency', `${(searchTotalMs / 100).toFixed(2)}ms`);
  row('p50 search', `${pct(searchTimes, 50)}ms`);
  row('p95 search', `${pct(searchTimes, 95)}ms`);
  row('p99 search', `${pct(searchTimes, 99)}ms`);
  row('Search throughput', `${(100 / (searchTotalMs / 1000)).toFixed(1)} searches/sec`);

  // ── 3. Concept-Expansion Search Benchmark ────────────────────────────────────
  console.log(`\n${BOLD}3. Concept-Expansion Search (50 synonym queries)${RESET}`);
  const synonymQueries = [
    'speed metrics', 'data analysis', 'system check',
    'project review', 'runtime evaluation',
  ];
  const expTimes = [];
  for (let i = 0; i < 50; i++) {
    const q = synonymQueries[i % synonymQueries.length];
    const { ms } = await post('/smart-search', { query: q, limit: 5, project });
    expTimes.push(ms);
  }
  const expTotal = expTimes.reduce((s, t) => s + t, 0);
  row('Avg expanded search', `${(expTotal / 50).toFixed(2)}ms`);
  row('p95 expanded search', `${pct(expTimes, 95)}ms`);
  row('Expansion throughput', `${(50 / (expTotal / 1000)).toFixed(1)} searches/sec`);

  // ── 4. Lesson Reinforcement ──────────────────────────────────────────────────
  console.log(`\n${BOLD}4. Lesson Reinforcement (10× save same content)${RESET}`);
  const lessonContent = 'Always use WAL journal mode for SQLite in write-heavy workloads. [bm3]';
  
  // Cleanup existing lesson if present to ensure clean benchmark run
  try {
    const res = await fetch(`${BASE_URL}/lessons`);
    if (res.ok) {
      const list = await res.json();
      const existing = list.find(l => l.content === lessonContent);
      if (existing) {
        await fetch(`${BASE_URL}/lessons/${existing.id}`, { method: 'DELETE' });
      }
    }
  } catch (_) {}

  let lastConf = 0;
  const lessonTimes = [];
  for (let i = 0; i < 10; i++) {
    const { data, ms } = await post('/lessons', { content: lessonContent, confidence: 1.0, project });
    lastConf = data.confidence;
    lessonTimes.push(ms);
  }
  const lessonTotal = lessonTimes.reduce((s, t) => s + t, 0);
  row('Final confidence', `${lastConf} (expected 10.0) → ${lastConf === 10 ? `${GREEN}PASS${RESET}` : `${YELLOW}FAIL${RESET}`}`);
  row('Avg lesson save', `${(lessonTotal / 10).toFixed(2)}ms`);

  // ── 5. Slot Chain ────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}5. Slot Chain (create → append × 5 → verify → delete)${RESET}`);
  const slotLabel = `bench_slot_${Date.now()}`;
  const { ms: sc } = await post('/slot/replace', { label: slotLabel, content: 'A' });
  const appendTimes = [];
  for (let i = 0; i < 5; i++) {
    const { ms } = await post('/slot/append', { label: slotLabel, text: String(i) });
    appendTimes.push(ms);
  }
  const { data: slotsList } = await get('/slots');
  const slotFinal = slotsList.find(s => s.label === slotLabel);
  row('Slot final content', `"${slotFinal?.content}" → ${slotFinal?.content === 'A01234' ? `${GREEN}PASS${RESET}` : `${YELLOW}FAIL${RESET}`}`);
  row('Avg append latency', `${(appendTimes.reduce((s,t)=>s+t,0)/5).toFixed(2)}ms`);

  // Cleanup slot
  await fetch(`${BASE_URL}/slot/${encodeURIComponent(slotLabel)}`, { method: 'DELETE' });

  // ── 6. Hook Throughput ───────────────────────────────────────────────────────
  console.log(`\n${BOLD}6. Hook Endpoint Throughput (50 PostToolUse events)${RESET}`);
  const hookTimes = [];
  let hookSaved = 0, hookSkipped = 0;
  const tools = ['write_to_file', 'run_command', 'multi_replace_file_content'];
  for (let i = 0; i < 50; i++) {
    const { data, ms } = await post('/hook', {
      event:       'PostToolUse',
      tool_name:   tools[i % tools.length],
      tool_result: `Hook test ${i}: executed ${tools[i % tools.length]} successfully with 120 chars of result output.`,
      project,
    });
    hookTimes.push(ms);
    if (data.id)       hookSaved++;
    if (data.skipped)  hookSkipped++;
  }
  const hookTotal = hookTimes.reduce((s,t)=>s+t,0);
  row('Hooks saved', `${hookSaved}`);
  row('Hooks skipped', `${hookSkipped}`);
  row('Avg hook latency', `${(hookTotal / 50).toFixed(2)}ms`);
  row('Hook throughput', `${(50 / (hookTotal / 1000)).toFixed(1)} events/sec`);

  // ── 7. Auto-Summarize Latency ────────────────────────────────────────────────
  console.log(`\n${BOLD}7. Auto-Summarize Latency${RESET}`);
  const { ms: sumMs, data: sumData } = await post('/session/summarize', {});
  row('Summarize latency', `${sumMs.toFixed(2)}ms`);
  row('Summary length', `${sumData.content?.length ?? 0} chars`);

  // ── Final Stats ──────────────────────────────────────────────────────────────
  const { data: stats } = await get('/stats');
  console.log(`\n${BOLD}Database State After Benchmark${RESET}`);
  row('Total memories', `${stats.memories}`);
  row('Total observations', `${stats.observations}`);
  row('Total sessions', `${stats.sessions}`);
  row('Concept edges', `${stats.concept_edges}`);
  row('Lessons', `${stats.lessons}`);

  console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════════╗`);
  console.log(`║           BENCHMARK COMPLETE                 ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  ${RESET}Write    ${(200 / (writeTotalMs / 1000)).toFixed(0).padEnd(6)} writes/sec  avg ${(writeTotalMs/200).toFixed(1).padEnd(6)}ms${CYAN}   ║`);
  console.log(`║  ${RESET}Search   ${(100 / (searchTotalMs / 1000)).toFixed(0).padEnd(6)} searches/sec avg ${(searchTotalMs/100).toFixed(1).padEnd(5)}ms${CYAN}   ║`);
  console.log(`║  ${RESET}Hooks    ${(50 / (hookTotal / 1000)).toFixed(0).padEnd(6)} events/sec  avg ${(hookTotal/50).toFixed(1).padEnd(5)}ms${CYAN}   ║`);
  console.log(`╚══════════════════════════════════════════════╝${RESET}\n`);
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
});
