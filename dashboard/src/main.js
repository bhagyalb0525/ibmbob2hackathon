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
  incidentBanner: () => $('incident-banner'),
  incidentBannerDetail: () => $('incident-banner-detail'),
  recoveryBanner: () => $('recovery-banner'),
  recoveryBannerDetail: () => $('recovery-banner-detail'),
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

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Incident / Recovery banners
// ---------------------------------------------------------------------------
function showIncidentBanner(incident) {
  const banner = mounts.incidentBanner();
  const detail = mounts.incidentBannerDetail();
  if (!banner || !detail) return;
  detail.textContent = `${incident.errorSignature} — ${incident.serviceName} ${incident.endpoint} (HTTP ${incident.httpStatus})`;
  banner.style.display = 'flex';
}

function hideIncidentBanner() {
  const banner = mounts.incidentBanner();
  if (banner) banner.style.display = 'none';
}

function showRecoveryBanner(message) {
  const banner = mounts.recoveryBanner();
  const detail = mounts.recoveryBannerDetail();
  if (!banner || !detail) return;
  detail.textContent = message || 'Fix verified and deployed';
  banner.style.display = 'flex';
}

function hideRecoveryBanner() {
  const banner = mounts.recoveryBanner();
  if (banner) banner.style.display = 'none';
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
  const lastStepMsg = history && history.length > 0 ? history[history.length - 1].message : '';
  const lastMsg = event.message || lastStepMsg || stage;

  const item = document.createElement('div');
  item.className = `activity-item activity-item--${cls}`;
  item.innerHTML = `
    <span class="activity-time">${fmtTime(event.timestamp)}</span>
    <span class="activity-msg">${escHtml(lastMsg)}</span>
    ${agent ? `<span class="stage-badge stage--${stage}" style="font-size:10px">${agent}</span>` : ''}`;

  feed.prepend(item);

  while (feed.children.length > MAX_FEED_ITEMS) {
    feed.removeChild(feed.lastChild);
  }
}

// ---------------------------------------------------------------------------
// Render all components from state
// ---------------------------------------------------------------------------
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
      renderAll(event.state, event.immune);
      addActivityItem(event);

      // Show/hide incident banner based on state
      if (event.type === 'INCIDENT_SEEDED' && event.state && event.state.incident) {
        showIncidentBanner(event.state.incident);
      }

      // Show recovery banner on resolution
      if (event.state && event.state.stage === 'RESOLVED') {
        hideIncidentBanner();
        const v = event.state.results && event.state.results.verification;
        const msg = v && v.patchApplied
          ? `Fix verified — ${v.passedTests}/${v.totalTests} tests passed`
          : 'Incident resolved';
        showRecoveryBanner(msg);
      } else if (event.state && event.state.stage === 'IMMUNE_RECOVERED') {
        hideIncidentBanner();
        const immune = event.immune;
        const msg = immune && immune.fixApplied
          ? `Recovered via immune memory in ${immune.memoryLatencyMs || 0}ms — fix reused`
          : 'Recovered via immune memory';
        showRecoveryBanner(msg);
      } else if (event.state && event.state.stage === 'FAILED') {
        hideIncidentBanner();
        hideRecoveryBanner();
      }
    } catch (err) {
      console.error('[SSE] Parse error', err);
    }
  });

  es.onopen = () => setBadge('connected', '● Live');

  es.onerror = () => {
    setBadge('error', '✕ Disconnected');
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

// ---------------------------------------------------------------------------
// Control buttons
// ---------------------------------------------------------------------------
function wireButtons() {
  const btnFull   = $('btn-trigger-full');
  const btnImmune = $('btn-trigger-immune');
  const btnDemo   = $('btn-demo');
  const btnReset  = $('btn-reset');

  if (btnFull) {
    btnFull.addEventListener('click', () => {
      hideRecoveryBanner();
      fetch('/api/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ immuneMatch: false }) })
        .catch(err => console.error('[trigger]', err));
    });
  }

  if (btnImmune) {
    btnImmune.addEventListener('click', () => {
      hideRecoveryBanner();
      fetch('/api/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ immuneMatch: true }) })
        .catch(err => console.error('[trigger-immune]', err));
    });
  }

  if (btnDemo) {
    btnDemo.addEventListener('click', () => {
      hideRecoveryBanner();
      hideIncidentBanner();
      fetch('/api/demo', { method: 'POST' })
        .catch(err => console.error('[demo]', err));
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      hideIncidentBanner();
      hideRecoveryBanner();
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
