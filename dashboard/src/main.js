// Frontend client — establishes SSE connection and renders dynamic pipeline state without page refresh

// ---------------------------------------------------------------------------
// DOM references (set after DOMContentLoaded)
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);

const mounts = {
  incident:  () => $('mount-incident-detail'),
  immune:    () => $('mount-immune-stats'),
  tracker:   () => $('mount-pipeline-tracker'),
  feed:      () => $('activity-feed'),
  badge:     () => $('connection-badge'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) { return iso; }
}

function setBadge(state, text) {
  const el = mounts.badge();
  if (!el) return;
  el.className = `badge badge--${state}`;
  el.textContent = text;
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------
const MAX_FEED_ITEMS = 60;

function addActivityItem(event) {
  const feed = mounts.feed();
  if (!feed) return;

  const cls = {
    INCIDENT_SEEDED:  'seeded',
    AGENT_STARTED:    'started',
    AGENT_COMPLETED:  'completed',
    PIPELINE_RESET:   'reset',
    STAGE_CHANGED:    event.state && (event.state.stage === 'IMMUNE_RECOVERED') ? 'immune' : 'started',
  }[event.type] || 'started';

  const stage   = event.state ? event.state.stage : '';
  const agent   = event.state ? event.state.activeAgent : '';
  const history = event.state && event.state.history;
  // Prefer the real message the server attached to the event; fall back to the
  // orchestrator's own latest history entry, then to the stage name.
  const lastStepMsg = history && history.length > 0 ? history[history.length - 1].message : '';
  const lastMsg = event.message || lastStepMsg || stage;

  const item = document.createElement('div');
  item.className = `activity-item activity-item--${cls}`;
  item.innerHTML = `
    <span class="activity-time">${fmtTime(event.timestamp)}</span>
    <span class="activity-msg">${escHtml(lastMsg)}</span>
    ${agent ? `<span class="stage-badge stage--${stage}" style="font-size:10px">${agent}</span>` : ''}`;

  feed.prepend(item);

  // Trim excess
  while (feed.children.length > MAX_FEED_ITEMS) {
    feed.removeChild(feed.lastChild);
  }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Render all components from state
// ---------------------------------------------------------------------------

/**
 * Real warm-path facts from the most recent immune-memory event.
 *
 * The server sends this as a sibling of `state` on STAGE_CHANGED (only on a
 * genuine match), so shared/types.ts needs no changes. It is passed to the
 * components as an optional second argument and is null on a cold run.
 */
let immuneDetail = null;

function renderAll(state, immune) {
  if (immune) immuneDetail = immune;
  if (window.__IncidentDetail)    window.__IncidentDetail.render(state,    mounts.incident(), immuneDetail);
  if (window.__ImmuneMemoryStats) window.__ImmuneMemoryStats.render(state, mounts.immune(),   immuneDetail);
  if (window.__PipelineTracker)   window.__PipelineTracker.render(state,   mounts.tracker(),  immuneDetail);
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------
let es = null;

function connectSSE() {
  if (es) { es.close(); es = null; }

  setBadge('connecting', 'Connecting…');
  es = new EventSource('/events');

  es.addEventListener('pipeline', e => {
    try {
      const event = JSON.parse(e.data);
      // `immune` carries the real matched entry / reused fix on a warm run.
      renderAll(event.state, event.immune);
      addActivityItem(event);
    } catch (err) {
      console.error('[SSE] Parse error', err);
    }
  });

  es.onopen = () => setBadge('connected', '● Live');

  es.onerror = () => {
    setBadge('error', '✕ Disconnected');
    es.close();
    // Reconnect after 3 s
    setTimeout(connectSSE, 3000);
  };
}

// ---------------------------------------------------------------------------
// Control buttons
// ---------------------------------------------------------------------------
function wireButtons() {
  const btnFull   = $('btn-trigger-full');
  const btnImmune = $('btn-trigger-immune');
  const btnReset  = $('btn-reset');

  if (btnFull) {
    btnFull.addEventListener('click', () => {
      fetch('/api/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ immuneMatch: false }) })
        .catch(err => console.error('[trigger]', err));
    });
  }

  if (btnImmune) {
    btnImmune.addEventListener('click', () => {
      fetch('/api/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ immuneMatch: true }) })
        .catch(err => console.error('[trigger-immune]', err));
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      fetch('/api/reset', { method: 'POST' })
        .catch(err => console.error('[reset]', err));
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  wireButtons();
  connectSSE();
});
