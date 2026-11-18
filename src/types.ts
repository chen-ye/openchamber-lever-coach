/**
 * Types for lever-coach provenance disambiguation and cross-session analysis.
 */

export type OrganicProvenanceCategory =
  | "organic_human_composer"
  | "organic_human_inline_comment"
  | "organic_human_slash_or_skill_arg";

export type SyntheticProvenanceCategory =
  | "plugin_autogate_classifier"
  | "subagent_child_session"
  | "cloned_fork_history"
  | "plugin_continuation_or_task_notification"
  | "plugin_hindsight_survey"
  | "openchamber_ui_magic_prompt"
  | "openchamber_auto_review"
  | "openchamber_ui_block_answer"
  | "openchamber_reply_command_run"
  | "openchamber_goal_continuation"
  | "openchamber_agent_dispatch"
  | "automated_harness_smoke_test"
  | "empty_text_context_only_turn";

export type ProvenanceCategory = OrganicProvenanceCategory | SyntheticProvenanceCategory;

export interface SessionRecord {
  readonly id: string;
  readonly project_id?: string | null;
  readonly parent_id?: string | null;
  readonly title?: string | null;
  readonly agent?: string | null;
  readonly model?: string | null;
  readonly directory?: string | null;
  readonly time_created: number;
  readonly time_updated?: number | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface MessageMetadata {
  readonly openchamber?: {
    readonly promptedBy?: unknown;
    readonly kind?: string;
  };
  readonly openchamberUiBlockAnswer?: {
    readonly messageId?: string;
    readonly block?: string;
    readonly answer?: unknown;
  };
  readonly openchamberReplyCommand?: unknown;
  readonly openchamberReplyCommandContinuation?: unknown;
  readonly openchamberContext?: unknown;
  readonly [key: string]: unknown;
}

export interface MessageData {
  readonly text?: string;
  readonly metadata?: MessageMetadata;
  readonly [key: string]: unknown;
}

export interface MessageRecord {
  readonly id: string;
  readonly session_id: string;
  readonly type: string;
  readonly seq: number;
  readonly time_created: number;
  readonly time_updated?: number | null;
  readonly data: MessageData;
}

export interface ToolState {
  readonly status?: string;
  readonly exit?: number;
  readonly error?: string | { readonly type?: string; readonly message?: string };
  readonly output?: string;
  readonly input?: Record<string, unknown>;
  readonly title?: string;
  readonly time?: {
    readonly start?: number;
    readonly end?: number;
  };
}

export interface PartData {
  readonly type?: string;
  readonly tool?: string;
  readonly callID?: string;
  readonly state?: ToolState;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface PartRecord {
  readonly id: string;
  readonly message_id: string;
  readonly session_id: string;
  readonly time_created: number;
  readonly data: PartData;
}

export interface DisambiguatedMessage {
  readonly messageId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly category: ProvenanceCategory;
  readonly isOrganic: boolean;
  readonly text: string;
  readonly reason: string;
  readonly timeCreated: number;
}

export interface ProvenanceStats {
  readonly totalAnalyzed: number;
  readonly organicCount: number;
  readonly syntheticCount: number;
  readonly organicPercentage: number;
  readonly syntheticPercentage: number;
  readonly byCategory: Record<ProvenanceCategory, number>;
}

export type DetectorName =
  | "disambiguation"
  | "error-recovery"
  | "prompt-compressor"
  | "harness-health"
  | "verification-gap";

export type LeverSeverity = "high" | "medium" | "low" | "info";

export interface LeverProposal {
  readonly id: string;
  readonly title: string;
  readonly detector: DetectorName;
  readonly severity: LeverSeverity;
  readonly frequency: number;
  readonly affectedSessions: readonly string[];
  readonly summary: string;
  readonly rationale: string;
  readonly proposedAction: string;
  readonly status: "review_pending";
  readonly evidence: Record<string, unknown>;
}

export interface ErrorRecoveryFinding {
  readonly triggerPattern: string;
  readonly exitOrError: string;
  readonly recoveryCommand: string;
  readonly occurrences: number;
  readonly sessionIds: readonly string[];
  readonly proposedLever: string;
}

export interface PromptCompressorFinding {
  readonly cluster: string;
  readonly clusterType: "organic_prompt" | "ad_hoc_script";
  readonly occurrences: number;
  readonly distinctSessions: number;
  readonly sampleTexts: readonly string[];
  readonly proposedLever: string;
}

export interface HarnessHealthFinding {
  readonly issueType:
    | "unavailable_tool"
    | "classify_result_leakage"
    | "hindsight_500"
    | "lsp_timeout"
    | "autogate_300s_timeout"
    | "permission_rejected";
  readonly identifier: string;
  readonly agentOrTool: string;
  readonly count: number;
  readonly impactDescription: string;
  readonly proposedLever: string;
}

export interface VerificationGapFinding {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly completionTurnSeq: number;
  readonly correctionTurnsCount: number;
  readonly rejectionSignals: readonly string[];
  readonly sampleCorrections: readonly string[];
  readonly proposedInvariantCheckLever: string;
}

export interface DetectorRunResult<T = unknown> {
  readonly detectorName: DetectorName;
  readonly findingsCount: number;
  readonly proposals: readonly LeverProposal[];
  readonly rawFindings: readonly T[];
  readonly executionTimeMs: number;
  readonly summary: string;
}

export interface AnalysisReport {
  readonly timestamp: number;
  readonly dbPath: string;
  readonly policiesPath?: string;
  readonly sessionCount: number;
  readonly executionTimeMs: number;
  readonly provenanceStats: ProvenanceStats;
  readonly results: Partial<Record<DetectorName, DetectorRunResult>>;
}

export interface AnalysisOptions {
  readonly dbPath?: string;
  readonly policiesPath?: string;
  readonly detector?: DetectorName | "all";
  readonly days?: number;
  readonly limit?: number;
  readonly json?: boolean;
}
