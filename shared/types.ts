/**
 * regen — Shared Type Definitions
 * 
 * Strict contract shared across:
 * - demo_service (Member A)
 * - memory engine (Member A)
 * - dashboard UI & SSE server (Member A)
 * - 5-agent pipeline & orchestrator (Member B)
 * 
 * DO NOT modify without mutual alignment between Member A and Member B.
 */

// ==========================================
// 1. INCIDENT & TELEMETRY SCHEMAS
// ==========================================

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface IncidentMetrics {
  errorRate: number;              // e.g. 0.20 for 20% failure rate
  affectedUsersPercent: number;  // e.g. 20
  p99LatencyMs: number;
  totalRequests: number;
  failedRequests: number;
}

export interface IncidentPayload {
  incidentId: string;
  timestamp: string;
  serviceName: string;
  environment: 'production' | 'staging' | 'demo';
  severity: IncidentSeverity;
  endpoint: string;
  httpStatus: number;
  errorSignature: string;          // Normalized hash or canonical error string for memory lookup
  errorMessage: string;
  stackTrace: string;
  culpritPayload?: Record<string, unknown>; // Triggering request body
  recentCommits?: Array<{
    hash: string;
    author: string;
    message: string;
    timestamp: string;
  }>;
  metrics: IncidentMetrics;
}

// ==========================================
// 2. PIPELINE & AGENT EXECUTION STATES
// ==========================================

export type PipelineStage = 
  | 'IDLE'
  | 'MEMORY_LOOKUP'
  | 'TRIAGING'
  | 'DIAGNOSING'
  | 'TREATING'
  | 'VERIFYING'
  | 'SCRIBING'
  | 'RESOLVED'
  | 'IMMUNE_RECOVERED'
  | 'FAILED';

export type AgentName = 
  | 'immune_memory'
  | 'triage'
  | 'diagnostic'
  | 'treatment'
  | 'verification'
  | 'scribe';

export type AgentStatus = 'idle' | 'running' | 'success' | 'failed' | 'skipped';

export interface BaseAgentResult {
  agentName: AgentName;
  status: AgentStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summary: string;
  error?: string;
}

// 2a. Triage Agent Result
export interface TriageResult extends BaseAgentResult {
  agentName: 'triage';
  rootCauseFile: string;
  suspectFunction: string;
  lineStart: number;
  lineEnd: number;
  culpritCommit?: string;
  blastRadiusScore: number;       // 0.0 - 1.0
  explanation: string;
}

// 2b. Diagnostic Agent Result
export interface DiagnosticResult extends BaseAgentResult {
  agentName: 'diagnostic';
  regressionTestPath: string;
  regressionTestCode: string;
  reproductionCommand: string;
  reproductionConfirmed: boolean;
}

// 2c. Treatment Agent Result
export interface ConfidenceScoreBreakdown {
  blastRadiusScore: number;       // Weight: 0.35 (lower blast radius = higher score)
  testSpecificityScore: number;   // Weight: 0.40 (targeted regression coverage)
  historicalSuccessScore: number; // Weight: 0.25 (past fix success for similar signatures)
}

export interface TreatmentResult extends BaseAgentResult {
  agentName: 'treatment';
  targetFile: string;
  gitDiff: string;
  patchedCode: string;
  confidenceScore: number;        // Composite 0.0 - 1.0 (e.g. 0.94)
  scoreBreakdown: ConfidenceScoreBreakdown;
  explanation: string;
}

// 2d. Verification Agent Result
export interface VerificationResult extends BaseAgentResult {
  agentName: 'verification';
  totalTests: number;
  passedTests: number;
  failedTests: number;
  regressionTestPassed: boolean;
  baselineUnitTestsPassed: boolean;
  suiteOutput: string;
  patchApplied: boolean;
}

// 2e. Scribe Agent Result
export interface ScribeResult extends BaseAgentResult {
  agentName: 'scribe';
  postmortemMarkdown: string;
  prTitle: string;
  prBody: string;
  slackNotificationText: string;
  postmortemFilePath?: string;
}

export type AnyAgentResult = 
  | TriageResult
  | DiagnosticResult
  | TreatmentResult
  | VerificationResult
  | ScribeResult;

// ==========================================
// 3. IMMUNE MEMORY SUBSYSTEM
// ==========================================

export interface ImmuneMemoryEntry {
  id: string;
  signature: string;              // Normalized error signature / vector key
  serviceName: string;
  errorPattern: string;           // Regex or semantic pattern of error message
  rootCauseFile: string;
  verifiedDiff: string;           // Tested & approved patch
  confidence: number;
  tags: string[];
  createdAt: string;
  hitCount: number;
  lastUsedAt?: string;
  embeddings?: number[];          // Float vector representation (optional)
}

export interface MemoryMatchResult {
  matched: boolean;
  confidence: number;             // Similarity score 0.0 - 1.0
  entry?: ImmuneMemoryEntry;
  latencyMs: number;
}

// ==========================================
// 4. ORCHESTRATOR & DASHBOARD TELEMETRY
// ==========================================

export interface PipelineHistoryStep {
  stage: PipelineStage;
  timestamp: string;
  agent?: AgentName;
  message: string;
}

export interface PipelineState {
  incidentId: string;
  stage: PipelineStage;
  activeAgent?: AgentName;
  startTime: string;
  lastUpdated: string;
  isImmuneMatch: boolean;
  memoryLatencyMs?: number;
  totalDurationMs?: number;
  incident?: IncidentPayload;
  results: {
    triage?: TriageResult;
    diagnostic?: DiagnosticResult;
    treatment?: TreatmentResult;
    verification?: VerificationResult;
    scribe?: ScribeResult;
  };
  history: PipelineHistoryStep[];
}

export interface DashboardEvent {
  type: 'STAGE_CHANGED' | 'AGENT_STARTED' | 'AGENT_COMPLETED' | 'INCIDENT_SEEDED' | 'PIPELINE_RESET';
  timestamp: string;
  state: PipelineState;
}
