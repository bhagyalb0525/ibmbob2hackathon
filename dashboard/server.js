// Dashboard server — static assets + SSE broker for the REAL REGEN pipeline.
//
// Phase 3: a real ShopFlow checkout failure produces a real IncidentPayload,
// which is handed to the EXISTING agents/orchestrator.ts. The orchestrator
// runs in a child process (dashboard/orchestrator-runner.js) because
// VerificationAgent executes the suite with a blocking spawnSync, which would
// otherwise freeze this server's event loop — and with it /events — for the
// whole verification stage. Only the standard library is used here; the
// orchestrator's TypeScript is loaded by the child, not by this process.

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const net   = require('net');
const { fork, spawn, exec } = require('child_process');

const REPO_ROOT   = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(__dirname, 'orchestrator-runner.js');

// ---------------------------------------------------------------------------
// Phase 4: runtime immune-memory persistence
//
// ImmuneMemoryStore.recordFix() is intentionally in-memory only. Each runner
// fork is a fresh process, so the entry would be lost. We capture the new
// entry via IPC (kind:'memoryEntry') and persist it to a local JSON file.
// Subsequent forks receive that file as storePath so ImmuneMemoryStore loads
// it at construction time and the warm-path findMatch() genuinely succeeds.
// ---------------------------------------------------------------------------
const RUNTIME_MEMORY_PATH = path.join(__dirname, '.regen-memory-runtime.json');

function loadRuntimeMemory() {
  try {
    const raw = fs.readFileSync(RUNTIME_MEMORY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;  // file absent or invalid — runner will use its own seed
  }
}

function saveRuntimeMemory(entries) {
  try {
    fs.writeFileSync(RUNTIME_MEMORY_PATH, JSON.stringify(entries, null, 2), 'utf8');
    console.log(`[dashboard] immune memory persisted to ${RUNTIME_MEMORY_PATH} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);
  } catch (err) {
    console.error('[dashboard] could not persist immune memory:', err.message);
  }
}

/**
 * Merge a new memory entry into the runtime store file.
 * If an entry with the same id already exists it is replaced (idempotent).
 */
function persistMemoryEntry(entry) {
  // Load what is already on disk (may include entries from previous runs)
  let existing = loadRuntimeMemory();
  if (!Array.isArray(existing)) {
    // First write: start with the seed entries so the runtime file is self-contained
    try {
      const seedRaw = fs.readFileSync(path.join(REPO_ROOT, 'memory', 'seed_memory.json'), 'utf8');
      existing = JSON.parse(seedRaw);
    } catch (_) {
      existing = [];
    }
  }
  const idx = existing.findIndex(e => e.id === entry.id);
  if (idx !== -1) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }
  saveRuntimeMemory(existing);
  return existing;
}

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
    // No synthetic id: an idle dashboard has no incident, so it reports none.
    // Every id shown in the UI now comes from a real captured IncidentPayload.
    incidentId: incidentId || null,
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

let pipelineState = makeFreshState();

// ---------------------------------------------------------------------------
// Real orchestrator execution (Phase 3)
//
// A real ShopFlow failure hands its real IncidentPayload to the EXISTING
// agents/orchestrator.ts. Nothing about the run is simulated: the stage
// transitions, agent results, patch, confidence and verification outcome all
// come from the real pipeline via its existing emitStateUpdate() hook.
// ---------------------------------------------------------------------------

/** @type {import('child_process').ChildProcess | null} */
let pipelineChild = null;
let pipelineStatus = 'idle';   // idle | running | resolved | failed
let lastPipelineError = null;

/**
 * Relay a real pipeline state over the existing SSE transport.
 *
 * `immune` is a sibling field of `state` carrying the real warm-path facts
 * (matched entry, reused diff, match score, lookup latency, skipped agents).
 * It is optional and only present on a genuine immune-memory hit, so the
 * existing event shape and shared/types.ts contracts stay untouched.
 */
function broadcastStage(state, immune) {
  pipelineState = state;
  const event = { type: 'STAGE_CHANGED', timestamp: new Date().toISOString(), state };
  if (immune) event.immune = immune;
  broadcast(event);
}

/** A local FAILED view — the orchestrator's own state is never written to. */
function failedState(incident, message) {
  const s = makeFreshState(incident ? incident.incidentId : 'inc_failed');
  s.stage = 'FAILED';
  s.incident = incident || null;
  s.history = [{ stage: 'FAILED', timestamp: new Date().toISOString(), message }];
  return s;
}

/**
 * Run the REAL orchestrator for a REAL incident and relay its real state onto
 * the existing SSE transport.
 *
 * The incident goes to the Orchestrator CONSTRUCTOR — the existing
 * runPipeline() signature takes no arguments.
 */
function runRealPipeline(incident) {
  if (pipelineChild) {
    console.warn(`[dashboard] a real pipeline run is already in progress — ignoring ${incident.incidentId}`);
    return Promise.resolve(null);
  }

  pipelineStatus = 'running';
  lastPipelineError = null;

  // Announce the real incident on a fresh local IDLE state that carries the
  // real payload. The orchestrator's state object is never mutated from here.
  const seeded = makeFreshState(incident.incidentId);
  seeded.incident = incident;
  pipelineState = seeded;
  broadcast({
    type: 'INCIDENT_SEEDED',
    timestamp: new Date().toISOString(),
    message:
      `Real incident detected: ${incident.errorSignature} — ` +
      `${incident.serviceName} ${incident.endpoint} (HTTP ${incident.httpStatus})`,
    state: seeded,
  });

  // Phase 4: pass the runtime memory file path so the orchestrator loads the
  // previously recorded fix from the cold-path run and can match it on the
  // warm path. If no runtime file exists yet, the runner falls back to the
  // seed file — correct behaviour for the very first (cold) run.
  const runtimeMemory = loadRuntimeMemory();
  const runnerOptions = runtimeMemory
    ? { storePath: RUNTIME_MEMORY_PATH }
    : {};   // first run: no runtime file yet, use seed defaults

  let child;
  try {
    child = fork(RUNNER_PATH, [], {
      cwd: REPO_ROOT,
      // Loads the orchestrator's TypeScript the same way `npm run run:pipeline`
      // does: ts-node for .ts, tsconfig-paths for the @shared/* aliases.
      execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env },
    });
  } catch (err) {
    pipelineStatus = 'failed';
    lastPipelineError = (err && err.message) || String(err);
    console.error('[dashboard] could not start the orchestrator runner:', lastPipelineError);
    broadcastStage(failedState(incident, lastPipelineError));
    return Promise.resolve(null);
  }

  pipelineChild = child;
  console.log(`[dashboard] real REGEN pipeline started for ${incident.incidentId} (runner pid ${child.pid})`);

  // Surface the pipeline's own console output in the dashboard terminal.
  if (child.stdout) child.stdout.on('data', d => process.stdout.write(`  [regen] ${d}`));
  if (child.stderr) child.stderr.on('data', d => process.stderr.write(`  [regen!] ${d}`));

  return new Promise(resolve => {
    child.on('message', msg => {
      if (!msg) return;

      if (msg.kind === 'state') {
        broadcastStage(msg.state, msg.immune);
        if (msg.immune) {
          console.log(
            `[dashboard] immune match: entry=${msg.immune.entry && msg.immune.entry.id} ` +
            `score=${Number(msg.immune.confidence).toFixed(3)} ` +
            `threshold=${msg.immune.threshold} ` +
            `latency=${msg.immune.memoryLatencyMs}ms ` +
            `fixApplied=${msg.immune.fixApplied} ` +
            `entries=${msg.immune.entryCount}`
          );
        }
        if (msg.state && msg.state.stage === 'RESOLVED') {
          pipelineStatus = 'resolved';
          onVerifiedFixApplied(msg.state).catch(e =>
            console.error('[dashboard] post-fix handling failed:', e.message));
        } else if (msg.state && msg.state.stage === 'IMMUNE_RECOVERED') {
          // Warm path: the orchestrator has already written the stored verified
          // fix to disk. The live service still has to be restarted to serve it.
          pipelineStatus = 'resolved';
          onImmuneRecovered(msg.immune).catch(e =>
            console.error('[dashboard] warm-path handling failed:', e.message));
        } else if (msg.state && msg.state.stage === 'FAILED') {
          pipelineStatus = 'failed';
        }
        return;
      }

      if (msg.kind === 'log') {
        console.log(`  [regen] ${msg.message}`);
        return;
      }

      if (msg.kind === 'error') {
        lastPipelineError = msg.message;
        pipelineStatus = 'failed';
        console.error(`[dashboard] real pipeline error: ${msg.message}`);
        broadcastStage(failedState(currentIncident, msg.message));
        return;
      }

      // Phase 4: persist the new verified memory entry so the next run can
      // find it via findMatch() and take the IMMUNE_RECOVERED fast path.
      if (msg.kind === 'memoryEntry') {
        console.log(`[dashboard] new verified memory entry received: ${msg.entry && msg.entry.id}`);
        persistMemoryEntry(msg.entry);
        return;
      }

      if (msg.kind === 'done') {
        broadcastStage(msg.state);
        if (msg.state && msg.state.stage === 'RESOLVED') pipelineStatus = 'resolved';
        else if (msg.state && msg.state.stage === 'IMMUNE_RECOVERED') pipelineStatus = 'resolved';
        else if (pipelineStatus !== 'failed') pipelineStatus = 'failed';
        resolve(msg.state);
      }
    });

    child.on('error', err => {
      pipelineStatus = 'failed';
      lastPipelineError = err.message;
      console.error('[dashboard] orchestrator runner error:', err.message);
      broadcastStage(failedState(incident, err.message));
    });

    child.on('exit', (code, signal) => {
      pipelineChild = null;
      if (pipelineStatus === 'running') {
        pipelineStatus = code === 0 ? 'resolved' : 'failed';
        if (code !== 0) {
          lastPipelineError = lastPipelineError ||
            `orchestrator exited with code ${code}${signal ? ` (${signal})` : ''}`;
        }
      }
      console.log(`[dashboard] real pipeline finished — status=${pipelineStatus}, exit=${code}${signal ? `, ${signal}` : ''}`);
      resolve(null);
    });

    child.send({ kind: 'run', incident, options: runnerOptions });
  });
}

// ---------------------------------------------------------------------------
// Demo service lifecycle
//
// A verified REGEN fix is written to demo_service/src/services/cart.ts on
// disk, but `npm run start:demo` compiles that module once at start-up. The
// live process would therefore keep serving the pre-fix code and keep
// returning HTTP 500. Reloading it is what lets the recovered checkout
// genuinely return HTTP 200.
// ---------------------------------------------------------------------------
let managedDemo = null;

function demoPort() {
  try { return Number(new URL(DEMO_SERVICE_URL).port) || 3001; } catch (_) { return 3001; }
}

function isDemoUp() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: demoPort() });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForDemoHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await forwardToDemoService('GET', '/health');
    if (r.ok && r.json && r.json.status === 'ok') return true;
    await new Promise(res => setTimeout(res, 400));
  }
  return false;
}

function spawnDemoService() {
  const child = spawn('npx ts-node demo_service/src/app.ts', [], {
    cwd: REPO_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEMO_SERVICE_PORT: String(demoPort()) },
  });
  if (child.stdout) child.stdout.on('data', d => process.stdout.write(`  [demo] ${d}`));
  if (child.stderr) child.stderr.on('data', d => process.stderr.write(`  [demo!] ${d}`));
  child.on('exit', code => {
    console.log(`[dashboard] managed demo service exited (code ${code})`);
    if (managedDemo === child) managedDemo = null;
  });
  return child;
}

/**
 * Stop whatever process is listening on the demo port so a respawned service
 * loads the verified cart.ts from disk (ts-node caches modules per process).
 */
function killListenerOnPort(port) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      exec(
        `powershell -NoProfile -Command "` +
          `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; ` +
          `if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"`,
        () => resolve()
      );
      return;
    }
    exec(`lsof -ti tcp:${port} | xargs kill -9 2>/dev/null || true`, () => resolve());
  });
}

/** Take over demo-service start-up only when nothing else is serving it. */
async function ensureDemoService() {
  if (process.env.MANAGE_DEMO_SERVICE === '0') return;
  if (managedDemo) return;
  if (await isDemoUp()) {
    console.log(`[dashboard] demo service already listening on :${demoPort()} — leaving it untouched`);
    return;
  }
  console.log(`[dashboard] starting demo service on :${demoPort()} (managed by this server)`);
  managedDemo = spawnDemoService();
  const healthy = await waitForDemoHealth();
  console.log(healthy
    ? '[dashboard] demo service is healthy'
    : '[dashboard] demo service did not become healthy — check the log above');
}

/**
 * Reload the demo service after a cold-path VERIFIED fix so the corrected
 * source is the code actually serving checkouts.
 */
async function onVerifiedFixApplied(state) {
  const v = state.results && state.results.verification;
  if (!v || !v.patchApplied || !v.regressionTestPassed) return;

  console.log('[dashboard] verified fix is on disk — reloading demo service so it serves the fix');
  await reloadDemoServiceAfterFix();
}

/**
 * Phase 4 — warm path recovery.
 *
 * On a real immune-memory hit the orchestrator has already written the stored
 * verified diff to disk (agents/orchestrator.ts → applyImmuneRecovery()).
 * The live service is still running the pre-fix code, so it must be restarted
 * for the recovery to be real. If the stored fix was not applied we say so
 * instead of restarting and claiming a recovery that did not happen.
 */
async function onImmuneRecovered(immune) {
  if (immune && immune.fixApplied === false) {
    console.error(
      '[dashboard] IMMUNE_RECOVERED but the stored fix was NOT applied: ' +
      `${immune.error || 'unknown reason'} — not restarting the demo service`
    );
    return;
  }

  const target = immune && immune.targetFile ? immune.targetFile : 'the root-cause file';
  console.log(`[dashboard] IMMUNE_RECOVERED — stored fix is live in ${target}, reloading demo service`);
  await reloadDemoServiceAfterFix();
}

/**
 * Restart the demo service so the live checkout process serves the verified
 * cart.ts on disk. Works whether this server or `npm run start:demo` started
 * the original process — the listener on the demo port is stopped first.
 */
async function reloadDemoServiceAfterFix() {
  if (process.env.MANAGE_DEMO_SERVICE === '0') {
    console.log(
      '[dashboard] MANAGE_DEMO_SERVICE=0 — demo service was not reloaded automatically. ' +
      'Restart npm run start:demo to serve the verified fix.'
    );
    return;
  }

  const port = demoPort();
  console.log(`[dashboard] reloading demo service on :${port} so ShopFlow serves the verified fix`);

  if (managedDemo) {
    try { managedDemo.kill(); } catch (_) {}
    managedDemo = null;
  }

  await killListenerOnPort(port);
  await new Promise(res => setTimeout(res, 1000));

  managedDemo = spawnDemoService();
  const healthy = await waitForDemoHealth();
  console.log(healthy
    ? '[dashboard] demo service reloaded — Pay Now will hit the repaired checkout code'
    : '[dashboard] demo service did not come back up after reload — check the log above');
}

// ---------------------------------------------------------------------------
// Phase 2 — ShopFlow → demo_service proxy
//
// The browser only ever talks to this server (one origin, no CORS). This
// module forwards ShopFlow checkout calls to the EXISTING demo_service and,
// on a real failure, converts the real error into the existing
// IncidentPayload shape from shared/types.ts (which is NOT modified).
// No new backend, no new dependency — Node's built-in http/https only.
// ---------------------------------------------------------------------------
const DEMO_SERVICE_URL = process.env.DEMO_SERVICE_URL || 'http://127.0.0.1:3001';

/** In-memory handoff for Phase 3 (no DB / Redis / file persistence). */
let currentIncident = null;

/** Real service name, read once from the demo service's own /health. */
let upstreamServiceName = null;

/** Forward a JSON request to the demo service. Never throws. */
function forwardToDemoService(method, path, bodyObj) {
  return new Promise(resolve => {
    let target;
    try {
      target = new URL(DEMO_SERVICE_URL + path);
    } catch (_) {
      return resolve({ ok: false, transportError: 'DEMO_SERVICE_URL is not a valid URL', status: 502 });
    }

    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const transport = target.protocol === 'https:' ? require('https') : require('http');

    const req = transport.request(
      {
        hostname: target.hostname,
        port:     target.port || (target.protocol === 'https:' ? 443 : 80),
        path:     target.pathname + target.search,
        method,
        headers:  payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : { Accept: 'application/json' },
        timeout: 10000,
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', d => { raw += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { /* non-JSON body */ }
          resolve({ ok: true, status: res.statusCode, json, raw });
        });
      }
    );

    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    req.on('error', err => {
      resolve({
        ok: false,
        transportError: `Cannot reach demo_service at ${DEMO_SERVICE_URL} (${err.code || err.message}). ` +
                        'Start it with: npm run start:demo',
        status: 502,
      });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** Read the demo service's real `service` name (cached after first success). */
async function resolveServiceName() {
  if (upstreamServiceName) return upstreamServiceName;
  const r = await forwardToDemoService('GET', '/health');
  if (r.ok && r.json && r.json.service) {
    upstreamServiceName = r.json.service;
  }
  return upstreamServiceName;
}

/**
 * Normalize a real error message into the canonical signature string the
 * existing TriageAgent ERROR_SIGNATURE_MAP understands.
 * "PAYMENT_MISMATCH_ERROR: Expected total … but calculated …" -> "PAYMENT_MISMATCH_ERROR"
 */
function signatureFromFailure(message, status, errorField) {
  const source = String(message || errorField || '').trim();
  if (source) {
    const head = source.split(':')[0].trim();
    if (head && head.length <= 120) return head;
  }
  return `HTTP_${status}_${String(errorField || 'UNKNOWN').replace(/\s+/g, '_').toUpperCase()}`;
}

function severityForStatus(status) {
  if (status >= 500) return 'HIGH';
  if (status >= 400) return 'MEDIUM';
  return 'LOW';
}

/**
 * Build an IncidentPayload (shared/types.ts:27-46) from the REAL failure.
 *
 * Field provenance:
 *   incidentId      derived from the real orderId the service echoed back
 *   timestamp       real capture time
 *   serviceName     real value from the service's own /health
 *   environment     'demo' — this IS the demo service
 *   severity        derived from the real HTTP status
 *   endpoint        real upstream path that failed
 *   httpStatus      real upstream status
 *   errorSignature  normalized from the real error message
 *   errorMessage    real `message` (or `error`) field from the response body
 *   stackTrace      NOT available upstream — see note below
 *   culpritPayload  the exact request body that was forwarded
 *   recentCommits   OMITTED — not derivable from a checkout response
 *   metrics         ZEROS — demo_service exposes no traffic metrics
 */
function buildIncidentFromFailure(result, forwardedBody) {
  const body    = result.json || {};
  const status  = result.status;
  const message = body.message || body.error || 'Unknown checkout failure';
  const orderId = body.orderId || (forwardedBody && forwardedBody.orderId) || `shopflow_${Date.now()}`;

  return {
    incidentId:     `inc_${orderId}`,
    timestamp:      new Date().toISOString(),
    serviceName:    upstreamServiceName || 'checkout-service',
    environment:    'demo',
    severity:       severityForStatus(status),
    endpoint:       '/api/checkout',
    httpStatus:     status,
    errorSignature: signatureFromFailure(message, status, body.error),
    errorMessage:   message,
    // The demo service catches the throw inside its route error handler
    // (routes/checkout.ts:85-94) and returns only err.message — no inner stack
    // frame is ever exposed to HTTP clients. We report that truthfully rather
    // than fabricating one. TriageAgent resolves the file from errorSignature.
    stackTrace:
      `${signatureFromFailure(message, status, body.error)} raised while handling POST /api/checkout ` +
      `in demo_service and converted to HTTP ${status} by the route error handler ` +
      `(demo_service/src/routes/checkout.ts:85-94). ` +
      'The demo service does not propagate an inner stack trace to HTTP clients.',
    culpritPayload: forwardedBody,
    // recentCommits intentionally omitted: a checkout response carries no VCS data.
    metrics: {
      errorRate:            0,   // not observable from a single checkout response
      affectedUsersPercent: 0,
      p99LatencyMs:         0,
      totalRequests:        0,
      failedRequests:       0,
    },
  };
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

  // ------ Pipeline trigger (Run Full Pipeline / Trigger Immune Match) ------
  // Starts the real orchestrator for the current ShopFlow-captured incident.
  // Immune vs cold path is decided inside agents/orchestrator.ts (findMatch).
  if (url === '/api/trigger' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let immuneMatch = false;
      try { immuneMatch = !!JSON.parse(body || '{}').immuneMatch; } catch (_) {}

      if (!currentIncident) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'no_active_incident',
          message:
            'No incident to run. Trigger a real checkout failure in ShopFlow first, ' +
            'then use Run Full Pipeline.',
        }));
        return;
      }

      if (pipelineChild) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'pipeline_busy',
          running: true,
          incidentId: currentIncident.incidentId,
          message: 'A real pipeline run is already in progress for this incident.',
        }));
        return;
      }

      console.log(
        `[dashboard] pipeline trigger (${immuneMatch ? 'immune button' : 'full run'}) ` +
        `for ${currentIncident.incidentId}`
      );
      runRealPipeline(currentIncident).catch(err =>
        console.error('[dashboard] Unhandled orchestrator err:', err));

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        mode: 'real-orchestrator',
        started: true,
        immuneMatchRequested: immuneMatch,
        incidentId: currentIncident.incidentId,
        message:
          immuneMatch
            ? 'Real pipeline started — warm path runs only if immune memory matches this incident.'
            : 'Real REGEN pipeline started for the captured ShopFlow incident.',
      }));
    });
    return;
  }

  // ------ Reset pipeline state ------
  if (url === '/api/reset' && req.method === 'POST') {
    // A reset must be authoritative: stop any in-flight run so its state
    // updates cannot overwrite the clean state, and drop every trace of the
    // previous incident so the dashboard reads as genuinely idle.
    if (pipelineChild) {
      try { pipelineChild.kill(); } catch (_) {}
      pipelineChild = null;
    }
    pipelineStatus = 'idle';
    lastPipelineError = null;
    currentIncident = null;
    pipelineState = makeFreshState();
    broadcast({ type: 'PIPELINE_RESET', timestamp: new Date().toISOString(), state: pipelineState });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ------ ShopFlow: real checkout proxy (Phase 2) ------
  // The browser never calls :3001 directly — this keeps one browser origin
  // and avoids needing CORS on the demo service (which must stay unmodified).
  if (url === '/api/shopflow/checkout' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', async () => {
      let forwarded;
      try {
        forwarded = JSON.parse(body);
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON in request body' }));
        return;
      }

      const result = await forwardToDemoService('POST', '/api/checkout', forwarded);

      // Upstream unreachable (service not running) — surface it clearly.
      if (!result.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.transportError }));
        return;
      }

      const upstreamBody = result.json || {};

      // A real backend failure (>=400) becomes a real IncidentPayload.
      if (result.status >= 400) {
        await resolveServiceName();
        const incident = buildIncidentFromFailure(result, forwarded);
        currentIncident = incident;
        console.log(`\n[dashboard] REAL incident captured from demo_service (HTTP ${result.status})`);
        console.log(`[dashboard]   incidentId     : ${incident.incidentId}`);
        console.log(`[dashboard]   serviceName    : ${incident.serviceName}`);
        console.log(`[dashboard]   endpoint       : ${incident.endpoint}`);
        console.log(`[dashboard]   errorSignature : ${incident.errorSignature}`);
        console.log(`[dashboard]   errorMessage   : ${incident.errorMessage}\n`);

        // Publish the real IncidentPayload to the dashboard immediately, so the
        // Incident Detail panel updates at the moment of the real failure
        // instead of waiting for the orchestrator child's first state update.
        // The pipeline run below will broadcast richer stage states on top.
        pipelineState = Object.assign({}, pipelineState, {
          incidentId: incident.incidentId,
          incident:   incident,
          lastUpdated: new Date().toISOString(),
        });
        broadcast({
          type: 'INCIDENT_CAPTURED',
          timestamp: new Date().toISOString(),
          message: `Incident ${incident.incidentId} captured from ${incident.endpoint} — HTTP ${incident.httpStatus} ${incident.errorSignature}`,
          state: pipelineState,
        });
      }

      // Pass the upstream status through unchanged so the browser sees the
      // real 500 / 402 / 400 — never a rewritten status.
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...upstreamBody,
        // Non-invasive additions so the browser UI can show real identifiers.
        _proxy: {
          upstream: `${DEMO_SERVICE_URL}/api/checkout`,
          status: result.status,
          incidentCaptured: result.status >= 400 ? currentIncident.incidentId : null,
        },
      }));
    });
    return;
  }

  // ------ ShopFlow: real backend health (lets the operator confirm wiring) ------
  if (url === '/api/shopflow/health' && req.method === 'GET') {
    forwardToDemoService('GET', '/health').then(async result => {
      if (!result.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.transportError }));
        return;
      }
      await resolveServiceName();
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.json || {}));
    });
    return;
  }

  // ------ Phase 3 handoff: the real captured IncidentPayload ------
  if (url === '/api/shopflow/incident' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ incident: currentIncident }));
    return;
  }

  // ------ Real pipeline run status (SSE carries the same information) ------
  if (url === '/api/shopflow/pipeline' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: pipelineStatus,
      running: !!pipelineChild,
      error: lastPipelineError,
      demoServiceManaged: !!managedDemo,
      state: pipelineState,
    }));
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
  console.log(`[dashboard] ShopFlow proxy -> ${DEMO_SERVICE_URL}/api/checkout`);
  console.log('[dashboard] REGEN runs the real orchestrator from real ShopFlow incidents');
  ensureDemoService().catch(err =>
    console.error('[dashboard] demo service startup failed:', err.message));
});
