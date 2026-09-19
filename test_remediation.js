/**
 * MemCore Remediation & Improvements Verification Test
 * Tests:
 * 1. Single-slot REST route (GET /slot/:label and GET /slot?label=)
 * 2. Session-End ghost session leak prevention
 * 3. Polarity/negation dedup guard
 * 4. In-place memory update (PUT /memories/:id)
 * 5. Context-pack generation (GET /context-pack & MCP)
 * 6. Durable memory retention floor (0.50)
 */

const http = require('http');

const PORT = parseInt(process.env.MEMCORE_PORT || '3111', 10);
const HOST = '127.0.0.1';

let passed = 0;
let failed = 0;

function pass(name, detail = '') {
  passed++;
  console.log(`[PASS] ${name}${detail ? ' - ' + detail : ''}`);
}

function fail(name, detail = '') {
  failed++;
  console.error(`[FAIL] ${name}${detail ? ' - ' + detail : ''}`);
}

function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: HOST,
      port: PORT,
      path: '/agentmemory' + path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };

    const request = http.request(options, (res) => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          const parsed = resBody ? JSON.parse(resBody) : null;
          resolve({ status: res.statusCode, data: parsed });
        } catch (_) {
          resolve({ status: res.statusCode, data: resBody });
        }
      });
    });

    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

async function runTests() {
  console.log('--- Starting MemCore Remediation Verification ---');

  // Test 1: Single Slot GET route
  console.log('\n1. Single Slot GET Route');
  const slotLabel = `test_slot_remed_${Date.now()}`;
  await req('POST', '/slot/create', { label: slotLabel, content: 'Slot content payload' });

  const slotDirectRes = await req('GET', `/slot/${encodeURIComponent(slotLabel)}`);
  if (slotDirectRes.status === 200 && slotDirectRes.data?.label === slotLabel && slotDirectRes.data?.content === 'Slot content payload') {
    pass('GET /slot/:label returns exact slot object');
  } else {
    fail('GET /slot/:label failed', JSON.stringify(slotDirectRes));
  }

  const slotQueryRes = await req('GET', `/slot?label=${encodeURIComponent(slotLabel)}`);
  if (slotQueryRes.status === 200 && Array.isArray(slotQueryRes.data) && slotQueryRes.data[0]?.label === slotLabel) {
    pass('GET /slot?label= returns array with matching slot');
  } else {
    fail('GET /slot?label= failed', JSON.stringify(slotQueryRes));
  }

  await req('DELETE', `/slot/${encodeURIComponent(slotLabel)}`);

  // Test 2: Ghost session leak prevention on session/end
  console.log('\n2. Session-End Ghost Leak Prevention');
  const testProject = `remed-test-${Date.now()}`;
  const startRes = await req('POST', '/session/start', { project: testProject, cwd: 'D:/test' });
  const sid = startRes.data.sessionId;

  await req('POST', '/remember', {
    content: 'Memory created during remediation test session.',
    type: 'observation',
    project: testProject
  });

  const endRes = await req('POST', '/session/end', { session_id: sid, project: testProject, summarize: true });
  if (endRes.status === 200 && endRes.data.status === 'ended') {
    pass('Session successfully ended with summarize=true');
  } else {
    fail('Session end failed', JSON.stringify(endRes));
  }

  const sessionsRes = await req('GET', '/sessions');
  const projectSessions = sessionsRes.data.filter(s => s.project === testProject);
  const activeSessions = projectSessions.filter(s => s.ended_at === null);

  if (activeSessions.length === 0) {
    pass('No ghost sessions left open after session/end');
  } else {
    fail(`Ghost session leak detected: ${activeSessions.length} sessions still open`, JSON.stringify(activeSessions));
  }

  // Test 3: Polarity / Negation Dedup Guard
  console.log('\n3. Polarity / Negation Dedup Guard');
  const posMemRes = await req('POST', '/remember', {
    content: 'Always enable foreign key constraints in SQLite.',
    type: 'convention',
    project: testProject
  });

  const negMemRes = await req('POST', '/remember', {
    content: 'Never enable foreign key constraints in SQLite.',
    type: 'convention',
    project: testProject
  });

  if (posMemRes.data.id !== negMemRes.data.id && !negMemRes.data.merged) {
    pass('Conflicting polarity statements correctly prevented from merging');
  } else {
    fail('Polarity collision: conflicting instruction was merged!', JSON.stringify(negMemRes.data));
  }

  // Clean up memories
  if (posMemRes.data.id) await req('DELETE', `/memories/${posMemRes.data.id}`);
  if (negMemRes.data.id) await req('DELETE', `/memories/${negMemRes.data.id}`);

  // Test 4: In-place memory update
  console.log('\n4. In-Place Memory Update');
  const createMemRes = await req('POST', '/remember', {
    content: 'Original memory content before edit.',
    type: 'arch',
    project: testProject,
    concepts: 'edit,test'
  });
  const memId = createMemRes.data.id;

  const updateRes = await req('PUT', `/memories/${memId}`, {
    content: 'Updated memory content after in-place edit.'
  });

  if (updateRes.status === 200 && updateRes.data.content === 'Updated memory content after in-place edit.') {
    pass('PUT /memories/:id updated memory content');
  } else {
    fail('PUT /memories/:id failed', JSON.stringify(updateRes));
  }

  const verifySearch = await req('POST', '/smart-search', { query: 'Updated memory content after in-place edit', project: testProject });
  if (verifySearch.data && verifySearch.data.some(m => m.id === memId)) {
    pass('Updated content verified searchable via FTS/search');
  } else {
    fail('Updated content not found in search');
  }

  await req('DELETE', `/memories/${memId}`);

  // Test 5: Context Pack REST Route
  console.log('\n5. Context Pack Generation');
  await req('POST', '/slot/create', { label: 'ACTIVE_GOALS', content: '- Goal 1: Fix MemCore flaws\n- Goal 2: Verify tests' });
  await req('POST', '/remember', {
    content: 'Always use parameterized queries for SQL operations.',
    type: 'convention',
    project: testProject
  });

  const packRes = await req('GET', `/context-pack?project=${encodeURIComponent(testProject)}&token_budget=1000`);
  if (packRes.status === 200 && packRes.data.context_pack && packRes.data.context_pack.includes('ACTIVE_GOALS')) {
    pass('Context pack generated with active goals and project conventions', `estimated tokens: ${packRes.data.estimated_tokens}`);
  } else {
    fail('Context pack generation failed', JSON.stringify(packRes));
  }

  await req('DELETE', '/slot/ACTIVE_GOALS');

  // Test 6: Durable Memory Retention Floor (0.50)
  console.log('\n6. Durable Memory Retention Floor');
  const durableMem = await req('POST', '/remember', {
    content: 'Durable architectural pattern that must survive consolidation.',
    type: 'arch',
    project: testProject
  });

  // Consolidate 50 times
  for (let i = 0; i < 50; i++) {
    await req('POST', '/consolidate', {});
  }

  const durableSearch = await req('POST', '/smart-search', { query: 'Durable architectural pattern survive', project: testProject });
  const preservedMem = durableSearch.data.find(m => m.id === durableMem.data.id);

  if (preservedMem && preservedMem.confidence >= 0.50) {
    pass('Durable memory maintained minimum 0.50 confidence floor across repeated consolidation', `confidence=${preservedMem.confidence}`);
  } else {
    fail('Durable memory decayed below floor or was pruned', JSON.stringify(preservedMem));
  }

  if (durableMem.data.id) await req('DELETE', `/memories/${durableMem.data.id}`);

  // Summary
  console.log('\n=============================================');
  console.log(`Results: Passed: ${passed}, Failed: ${failed}`);
  console.log('=============================================');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
