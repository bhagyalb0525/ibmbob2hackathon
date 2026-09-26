/**
 * regen — Shared Constants & Configuration Defaults
 * 
 * Strict contract shared across:
 * - demo_service (Member A)
 * - memory engine (Member A)
 * - dashboard UI & SSE server (Member A)
 * - 5-agent pipeline & orchestrator (Member B)
 */

export const PIPELINE_STAGES = {
  IDLE: 'IDLE',
  MEMORY_LOOKUP: 'MEMORY_LOOKUP',
  TRIAGING: 'TRIAGING',
  DIAGNOSING: 'DIAGNOSING',
  TREATING: 'TREATING',
  VERIFYING: 'VERIFYING',
  SCRIBING: 'SCRIBING',
  RESOLVED: 'RESOLVED',
  IMMUNE_RECOVERED: 'IMMUNE_RECOVERED',
  FAILED: 'FAILED',
} as const;

export const AGENT_NAMES = {
  IMMUNE_MEMORY: 'immune_memory',
  TRIAGE: 'triage',
  DIAGNOSTIC: 'diagnostic',
  TREATMENT: 'treatment',
  VERIFICATION: 'verification',
  SCRIBE: 'scribe',
} as const;

export const INCIDENT_SEVERITY = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;

export const THRESHOLDS = {
  /** Minimum cosine similarity required to trigger an instant Immune Memory bypass */
  IMMUNE_SIMILARITY_THRESHOLD: 0.85,
  /** Minimum confidence score from Treatment Agent to attempt auto-verification */
  TREATMENT_MIN_CONFIDENCE: 0.80,
  /** Maximum allowable execution time before pipeline timeout (ms) */
  PIPELINE_TIMEOUT_MS: 90000,
} as const;

export const EVENT_CHANNELS = {
  STAGE_UPDATE: 'STAGE_UPDATE',
  AGENT_START: 'AGENT_START',
  AGENT_FINISH: 'AGENT_FINISH',
  INCIDENT_TRIGGER: 'INCIDENT_TRIGGER',
  RESET: 'RESET',
} as const;

export const DEFAULT_PORTS = {
  DASHBOARD_SERVER: 3000,
  DEMO_SERVICE: 3001,
} as const;

export const RELATIVE_PATHS = {
  DEMO_CART_SERVICE: 'demo_service/src/services/cart.ts',
  REGRESSION_TEST_DIR: 'demo_service/tests/regression',
  SEED_MEMORY_STORE: 'memory/seed_memory.json',
  POSTMORTEM_TEMPLATE: 'docs/POSTMORTEM_TEMPLATE.md',
  GENERATED_POSTMORTEMS: 'docs/postmortems',
} as const;
