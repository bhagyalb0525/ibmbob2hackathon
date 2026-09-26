// Lightweight SSE broker relaying agent stage updates from the orchestrator to the browser.
// No external dependencies — uses Node's built-in http module + a simple in-memory state store.

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT      = Number(process.env.DASHBOARD_PORT) || 4000;
const STATIC_DIR = path.join(__dirname);  // serves index.html from dashboard/

// ---------------------------------------------------------------------------
// SSE client registry
// ---------------------------------------------------------------------------
/** @type {Map<number, import('http').ServerResponse>} */
const clients = new Map();
let nextClientId = 1;

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const [id, res] of clients) {
    try {
      res.write(`event: pipeline\n`);
      res.write(data);
    } catch (_) {
      clients.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory pipeline state  (mirrors PipelineState from shared/types.ts)
// ---------------------------------------------------------------------------
function makeFreshState(incidentId) {
  return {
    incidentId: incidentId || `inc_${Date.now()}`,
    stage: 'IDLE',
    activeAgent: null,
    startTime: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    isImmuneMatch: false,
    memoryLatencyMs: null,
    totalDurationMs: null,
    incident: null,
    results: {},
    history: [],
  };
}

let pipelineState = makeFreshState('inc_demo_001');

function pushHistory(stage, message, agent) {
  pipelineState.history.push({
    stage,
    timestamp: new Date().toISOString(),
    agent: agent || undefined,
    message,
  });
}

// ---------------------------------------------------------------------------
// Demo incident payload (mirrors IncidentPayload from shared/types.ts)
// ---------------------------------------------------------------------------
const DEMO_INCIDENT = {
  incidentId:     'inc_demo_001',
  timestamp:      new Date().toISOString(),
  serviceName:    'checkout-service',
  environment:    'demo',
  severity:       'HIGH',
  endpoint:       '/api/checkout',
  httpStatus:     500,
  errorSignature: 'TypeError:Cannot read properties of undefined reading price',
  errorMessage:   "TypeError: Cannot read properties of undefined (reading 'price')",
  stackTrace:     'at calculateCart (cart.ts:54:36)\n at checkoutRouter (checkout.ts:41:22)',
  culpritPayload: { items: [{ id: 'x', name: 'test', quantity: 1 }] },
  recentCommits:  [{ hash: 'a1b2c3d', author: 'dev', message: 'refactor cart', timestamp: new Date().toISOString() }],
  metrics: {
    errorRate:             0.22,
    affectedUsersPercent:  22,
    p99LatencyMs:          1840,
    totalRequests:         500,
    failedRequests:        110,
  },
};

// ---------------------------------------------------------------------------
// Simulated pipeline replay
// Runs a full incident → resolution cycle to provide demo SSE events
// ---------------------------------------------------------------------------
const STAGES = [
  { stage: 'MEMORY_LOOKUP',   agent: 'immune_memory', ms: 600,  message: 'Searching immune memory for matching signature…' },
  { stage: 'TRIAGING',        agent: 'triage',         ms: 1200, message: 'Triage agent analysing root cause…' },
  { stage: 'DIAGNOSING',      agent: 'diagnostic',     ms: 1000, message: 'Diagnostic agent reproducing regression…' },
  { stage: 'TREATING',        agent: 'treatment',      ms: 1500, message: 'Treatment agent generating patch…' },
  { stage: 'VERIFYING',       agent: 'verification',   ms: 1000, message: 'Verification agent running test suite…' },
  { stage: 'SCRIBING',        agent: 'scribe',         ms: 800,  message: 'Scribe agent composing post-mortem…' },
  { stage: 'RESOLVED',        agent: null,             ms: 400,  message: 'Incident resolved. All agents completed successfully.' },
];

let replayTimer = null;

function runReplay(immuneMatch) {
  if (replayTimer) clearTimeout(replayTimer);

  const startMs = Date.now();
  pipelineState = makeFreshState('inc_demo_001');
  pipelineState.incident   = DEMO_INCIDENT;
  pipelineState.stage      = 'MEMORY_LOOKUP';
  pipelineState.isImmuneMatch = !!immuneMatch;

  // INCIDENT_SEEDED event
  pushHistory('MEMORY_LOOKUP', 'Incident seeded — starting pipeline');
  broadcast({ type: 'INCIDENT_SEEDED', timestamp: new Date().toISOString(), state: { ...pipelineState } });

  let delay = 0;
  const stageList = immuneMatch
    ? [
        { stage: 'MEMORY_LOOKUP', agent: 'immune_memory', ms: 400, message: 'Immune memory match found — instant recovery' },
        { stage: 'IMMUNE_RECOVERED', agent: null, ms: 300, message: 'Incident resolved via immune memory (no agents needed).' },
      ]
    : STAGES;

  for (let i = 0; i < stageList.length; i++) {
    const step = stageList[i];
    delay += (i === 0 ? 200 : stageList[i - 1].ms);

    replayTimer = setTimeout(() => {
      pipelineState.stage       = step.stage;
      pipelineState.activeAgent = step.agent || undefined;
      pipelineState.lastUpdated = new Date().toISOString();
      pushHistory(step.stage, step.message, step.agent);

      if (step.stage === 'MEMORY_LOOKUP' && immuneMatch) {
        pipelineState.memoryLatencyMs = 38;
      }
      if (step.stage === 'RESOLVED' || step.stage === 'IMMUNE_RECOVERED') {
        pipelineState.totalDurationMs = Date.now() - startMs;
        pipelineState.activeAgent = undefined;
        // Add mock results for resolved
        if (!immuneMatch) {
          pipelineState.results = {
            triage: {
              agentName: 'triage', status: 'success',
              startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 1200,
              summary: 'Root cause identified in cart.ts line 54',
              rootCauseFile: 'demo_service/src/services/cart.ts',
              suspectFunction: 'calculateCart',
              lineStart: 54, lineEnd: 58,
              culpritCommit: 'a1b2c3d',
              blastRadiusScore: 0.35,
              explanation: 'Undefined item in cart array causes price access to throw',
            },
            treatment: {
              agentName: 'treatment', status: 'success',
              startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 1500,
              summary: 'Patch generated: add optional chaining on item.price',
              targetFile: 'demo_service/src/services/cart.ts',
              gitDiff: '- const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);\n+ const subtotal = items.reduce((sum, i) => sum + (i?.price ?? 0) * (i?.quantity ?? 0), 0);',
              patchedCode: 'const subtotal = items.reduce((sum, i) => sum + (i?.price ?? 0) * (i?.quantity ?? 0), 0);',
              confidenceScore: 0.94,
              scoreBreakdown: { blastRadiusScore: 0.35, testSpecificityScore: 0.40, historicalSuccessScore: 0.25 },
              explanation: 'Optional chaining prevents runtime TypeError when item is undefined',
            },
            verification: {
              agentName: 'verification', status: 'success',
              startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 1000,
              summary: '7/7 tests passed, regression test green',
              totalTests: 7, passedTests: 7, failedTests: 0,
              regressionTestPassed: true, baselineUnitTestsPassed: true,
              suiteOutput: 'PASS demo_service/tests/unit/cart.test.ts\n  7 passed, 0 failed',
              patchApplied: true,
            },
          };
        }
      }

      const eventType = step.agent
        ? (i < stageList.length - 1 ? 'AGENT_STARTED' : 'AGENT_COMPLETED')
        : 'STAGE_CHANGED';

      broadcast({ type: eventType, timestamp: new Date().toISOString(), state: { ...pipelineState, results: { ...pipelineState.results } } });
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// Static file serving helpers
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // ------ SSE endpoint ------
  if (url === '/events') {
    const id = nextClientId++;
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // Send current state immediately on connect
    res.write(`event: pipeline\n`);
    res.write(`data: ${JSON.stringify({ type: 'STAGE_CHANGED', timestamp: new Date().toISOString(), state: pipelineState })}\n\n`);
    // Heartbeat every 15 s to keep the connection alive
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); clients.delete(id); }
    }, 15000);
    clients.set(id, res);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(id); });
    return;
  }

  // ------ Trigger demo replay ------
  if (url === '/api/trigger' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let immuneMatch = false;
      try { immuneMatch = !!JSON.parse(body).immuneMatch; } catch (_) {}
      runReplay(immuneMatch);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, immuneMatch }));
    });
    return;
  }

  // ------ Reset pipeline state ------
  if (url === '/api/reset' && req.method === 'POST') {
    if (replayTimer) clearTimeout(replayTimer);
    pipelineState = makeFreshState('inc_demo_001');
    broadcast({ type: 'PIPELINE_RESET', timestamp: new Date().toISOString(), state: pipelineState });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ------ Static files ------
  if (url === '/' || url === '/index.html') {
    return serveFile(res, path.join(STATIC_DIR, 'index.html'));
  }

  // Map /src/* to dashboard/src/*
  if (url.startsWith('/src/')) {
    const rel  = url.slice(1); // 'src/...'
    const file = path.join(STATIC_DIR, rel);
    // Safety: prevent path traversal outside dashboard/
    if (!file.startsWith(STATIC_DIR)) {
      res.writeHead(403); res.end(); return;
    }
    return serveFile(res, file);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[dashboard] Server running at http://localhost:${PORT}`);
  console.log(`[dashboard] SSE stream   at http://localhost:${PORT}/events`);
  console.log(`[dashboard] Trigger demo: POST http://localhost:${PORT}/api/trigger`);
});
