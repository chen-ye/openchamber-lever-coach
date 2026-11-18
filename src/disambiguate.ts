/**
 * Deterministic prompt provenance classifier.
 *
 * Accurately separates organic human prompts from all injected, synthetic,
 * subagent, cloned fork, and OpenChamber Magic Prompt messages.
 */

import type {
  DisambiguatedMessage,
  MessageRecord,
  ProvenanceCategory,
  ProvenanceStats,
  SessionRecord,
} from "./types.ts";

export const KNOWN_SUBAGENTS: readonly string[] = [
  "auto-gate-eval",
  "hindsight-survey",
  "explore",
  "librarian",
  "architect",
  "critic",
  "general",
  "Sisyphus-Junior",
  "oracle",
  "Momus - Plan Critic",
  "Metis - Plan Consultant",
  "multimodal-looker",
  "review",
  "review-changes",
  "rev-reviewer",
  "rev-verifier",
  "rev-fit",
];

export const MAGIC_PROMPT_VISIBLE_PREFIXES: readonly string[] = [
  "Implement this plan:",
  "Improve this plan:",
  "Prepare a handoff for another agent to review this work.",
  "Review the changes made in this workspace.",
  "Summarize this session",
  "Tidy up my memory:",
  "Please review the changes described in this handoff.",
  "Please review the current workspace changes.",
  "Another agent reviewed your changes and left the feedback below.",
  "The agent implementing the changes has responded to the previous review feedback.",
  "I want to start planning a feature.",
  "Help me turn an idea or task into a clear, verifiable Goal.",
  "Help me set up a scheduled task.",
  "Catch me up on where this project is right now.",
  "I want to debug an issue.",
  "Help me decide how to approach this.",
  "Give me a high-level tour of this codebase.",
  "Create the best combined answer from the multi-run results.",
  "You are generating a Conventional Commits subject line",
  "You are drafting a ",
  "Investigate the ",
  "Resolve cherry-pick conflicts, stage the resolved files, and continue the cherry-pick.",
  "This message below comes from an AI agent in another session.",
  "This message bellow comes from an AI agent in another session.",
  "The message I share is an assignment handed over from another AI agent.",
  "I want you to respond according to the content of message I share:",
];

export const MAGIC_PROMPT_INSTRUCTION_MARKERS: readonly string[] = [
  "You are starting from a project todo item.",
  "You are starting from an existing implementation plan",
  "This review is part of an automatic review loop.",
];

export function isOrganicCategory(category: ProvenanceCategory): boolean {
  return (
    category === "organic_human_composer" ||
    category === "organic_human_inline_comment" ||
    category === "organic_human_slash_or_skill_arg"
  );
}

/**
 * Extracts the user's substantive comment text from an inline quote/diff comment.
 */
export function extractInlineCommentText(
  fullText: string,
  metadata?: Record<string, unknown>
): string {
  if (
    metadata?.["openchamberContext"] &&
    typeof metadata["openchamberContext"] === "object" &&
    typeof (metadata["openchamberContext"] as Record<string, unknown>)["text"] === "string"
  ) {
    const ctxText = (
      (metadata["openchamberContext"] as Record<string, unknown>)["text"] as string
    ).trim();
    if (ctxText.length > 0) return ctxText;
  }

  const lines = fullText.split("\n");
  let seenQuote = false;
  const afterLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith(">")) {
      seenQuote = true;
    } else if (seenQuote) {
      afterLines.push(line);
    }
  }

  const extracted = afterLines.join("\n").trim();
  return extracted.length > 0 ? extracted : fullText.trim();
}

/**
 * Classifies a message within the context of its parent session and preceding message history.
 */
export function classifyPromptProvenance(
  message: MessageRecord,
  session: SessionRecord,
  precedingMessage?: MessageRecord | null
): DisambiguatedMessage {
  const text = message.data.text ?? "";
  const trimmed = text.trim();
  const timeCreated = message.time_created;

  // 1. Check for empty or context-only turns
  if (
    trimmed === "" ||
    (trimmed.startsWith("[Attachment unavailable after migration") && !trimmed.includes("\n\n"))
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "empty_text_context_only_turn",
      isOrganic: false,
      text,
      reason: "Message contains empty text or migration placeholder only",
      timeCreated,
    };
  }

  // 2. Check for cloned fork history
  // In OpenCode, forked sessions clone message history with patterned IDs like msg_*_0 or timestamps prior to session creation
  const isForkClonedId = /^msg_[a-zA-Z0-9]+_\d+$/.test(message.id);
  const isPreSessionTimestamp = session.time_created > 0 && message.time_created < session.time_created;
  if (isForkClonedId || isPreSessionTimestamp) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "cloned_fork_history",
      isOrganic: false,
      text,
      reason: isForkClonedId
        ? `Fork-cloned compound message ID pattern (${message.id})`
        : `Message timestamp (${message.time_created}) precedes session creation (${session.time_created})`,
      timeCreated,
    };
  }

  // 3. AutoGate classifier
  if (
    session.agent === "auto-gate-eval" ||
    trimmed.startsWith("AutoGate: Evaluate") ||
    trimmed.includes("AutoGate permission classifier") ||
    trimmed.startsWith("Evaluation prompt:") ||
    trimmed.includes("[auto-gate control]")
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "plugin_autogate_classifier",
      isOrganic: false,
      text,
      reason: "AutoGate evaluation agent turn or permission classification prompt",
      timeCreated,
    };
  }

  // 4. Hindsight survey
  if (
    session.agent === "hindsight-survey" ||
    trimmed.includes("Hindsight memory survey") ||
    trimmed.includes("openchamber_memory tool")
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "plugin_hindsight_survey",
      isOrganic: false,
      text,
      reason: "Hindsight memory survey session or memory tidy-up directive",
      timeCreated,
    };
  }

  // 5. Subagent child sessions
  const hasParentId =
    session.parent_id !== null &&
    session.parent_id !== undefined &&
    session.parent_id.trim() !== "";
  const isKnownSubagent =
    session.agent !== null &&
    session.agent !== undefined &&
    KNOWN_SUBAGENTS.includes(session.agent);

  if (hasParentId || isKnownSubagent) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "subagent_child_session",
      isOrganic: false,
      text,
      reason: hasParentId
        ? `Child session dispatched from parent ${session.parent_id}`
        : `Autonomous subagent profile (${session.agent ?? "unknown"})`,
      timeCreated,
    };
  }

  // 6. OpenChamber Auto Review
  const isReviewSession =
    session.metadata?.["openchamber"] &&
    typeof session.metadata["openchamber"] === "object" &&
    ((session.metadata["openchamber"] as Record<string, unknown>)["kind"] === "review" ||
      (session.metadata["openchamber"] as Record<string, unknown>)["kind"] === "workflow-agent");

  const precedingText = precedingMessage?.data.text ?? "";
  const precedingHasReviewLoop = precedingText.includes("This review is part of an automatic review loop.");

  if (isReviewSession || precedingHasReviewLoop) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "openchamber_auto_review",
      isOrganic: false,
      text,
      reason: "Automated review loop session or review workflow agent",
      timeCreated,
    };
  }

  // 7. OpenChamber UI Block Answer
  const hasUiBlockAnswerMetadata = message.data.metadata?.openchamberUiBlockAnswer !== undefined;
  if (
    hasUiBlockAnswerMetadata ||
    trimmed.startsWith("The user answered the UI block in your previous reply:")
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "openchamber_ui_block_answer",
      isOrganic: false,
      text,
      reason: "Automated response from inline OpenChamber UI block interaction",
      timeCreated,
    };
  }

  // 8. OpenChamber Reply Command Run
  const hasReplyCommandMetadata =
    message.data.metadata?.openchamberReplyCommand !== undefined ||
    message.data.metadata?.openchamberReplyCommandContinuation !== undefined;
  if (
    hasReplyCommandMetadata ||
    trimmed.startsWith("Run this command in the project directory:") ||
    trimmed.startsWith("The user ran this command:")
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "openchamber_reply_command_run",
      isOrganic: false,
      text,
      reason: "OpenChamber reply command execution trigger",
      timeCreated,
    };
  }

  // 9. OpenChamber Agent Dispatch
  const hasPromptedByMetadata = message.data.metadata?.openchamber?.promptedBy !== undefined;
  if (
    hasPromptedByMetadata ||
    trimmed.startsWith("This message below comes from an AI agent in another session.") ||
    trimmed.startsWith("This message bellow comes from an AI agent in another session.")
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "openchamber_agent_dispatch",
      isOrganic: false,
      text,
      reason: "Cross-session agent dispatch with promptedBy metadata or transfer preface",
      timeCreated,
    };
  }

  // 10. OpenChamber Goal Continuation
  if (
    trimmed.startsWith("The session goal is still open.") ||
    trimmed.includes("Take it through to the end in this run.") ||
    trimmed.startsWith("[GOAL CONTINUATION]")
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "openchamber_goal_continuation",
      isOrganic: false,
      text,
      reason: "Automated goal continuation trigger from goal runner loop",
      timeCreated,
    };
  }

  // 11. Plugin Continuation or Task Notification
  if (
    trimmed.startsWith("[SYSTEM DIRECTIVE: OH-MY-OPENCODE") ||
    trimmed.includes("<!-- OMO_INTERNAL_INITIATOR -->") ||
    trimmed.startsWith("[TASK NOTIFICATION]") ||
    trimmed.includes("Incomplete tasks remain in your todo list")
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "plugin_continuation_or_task_notification",
      isOrganic: false,
      text,
      reason: "Plugin internal directive or task notification",
      timeCreated,
    };
  }

  // 12. OpenChamber Magic Prompts
  // Check preceding seq - 1 synthetic instructions
  if (precedingMessage && precedingMessage.type === "synthetic") {
    const precedingInstructions = precedingMessage.data.text ?? "";
    for (const marker of MAGIC_PROMPT_INSTRUCTION_MARKERS) {
      if (precedingInstructions.includes(marker)) {
        return {
          messageId: message.id,
          sessionId: session.id,
          seq: message.seq,
          category: "openchamber_ui_magic_prompt",
          isOrganic: false,
          text,
          reason: `Preceded by synthetic Magic Prompt instruction: "${marker}"`,
          timeCreated,
        };
      }
    }
  }

  // Check all visible Magic Prompt prefixes
  for (const prefix of MAGIC_PROMPT_VISIBLE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return {
        messageId: message.id,
        sessionId: session.id,
        seq: message.seq,
        category: "openchamber_ui_magic_prompt",
        isOrganic: false,
        text,
        reason: `Matches OpenChamber Magic Prompt prefix: "${prefix}"`,
        timeCreated,
      };
    }
  }

  // 13. Automated harness smoke test
  const sessionTitle = session.title?.toLowerCase() ?? "";
  if (
    sessionTitle.includes("smoke test") ||
    sessionTitle.includes("smoke-test") ||
    trimmed === "PING" ||
    trimmed === "smoke-test" ||
    trimmed.startsWith("[SMOKE TEST]")
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "automated_harness_smoke_test",
      isOrganic: false,
      text,
      reason: "Harness smoke test or health check session",
      timeCreated,
    };
  }

  // 14. Automated skill instruction wrapper without user request
  if (
    (trimmed.startsWith("<auto-slash-command>") || trimmed.startsWith("<skill-instruction>")) &&
    (!trimmed.includes("<user-request>") || /<user-request>\s*<\/user-request>/.test(trimmed))
  ) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "plugin_continuation_or_task_notification",
      isOrganic: false,
      text,
      reason: "Automated skill instruction wrapper without user request",
      timeCreated,
    };
  }

  // 15. OpenChamber Organic Inline Comments (stored in synthetic or user turns)
  const hasOpenchamberContext = message.data.metadata?.openchamberContext !== undefined;
  const isCommentOn = trimmed.startsWith("Comment on ");
  if (hasOpenchamberContext || isCommentOn) {
    const extractedComment = extractInlineCommentText(text, message.data.metadata);
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "organic_human_inline_comment",
      isOrganic: true,
      text: extractedComment,
      reason: "OpenChamber user inline comment on quote/diff context",
      timeCreated,
    };
  }

  // 16. If message.type is synthetic but wasn't caught above, it's synthetic
  if (message.type === "synthetic") {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "plugin_continuation_or_task_notification",
      isOrganic: false,
      text,
      reason: "Generic synthetic message payload",
      timeCreated,
    };
  }

  // 17. Message is Organic Human! Determine specific organic subtype
  // Subtype A: Inline review comment
  const isInlineComment =
    /^[\w./\\-]+:\d+(?::\d+)?:/.test(trimmed) ||
    trimmed.startsWith("> ") ||
    trimmed.includes("[inline-review-comment]") ||
    (trimmed.includes("@@") && trimmed.includes("diff --git"));

  if (isInlineComment) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "organic_human_inline_comment",
      isOrganic: true,
      text,
      reason: "Organic human inline review comment or diff quotation",
      timeCreated,
    };
  }

  // Subtype B: Slash command or skill argument typed by human
  const hasSkillsArray =
    Array.isArray((message.data as Record<string, unknown>)["skills"]) &&
    ((message.data as Record<string, unknown>)["skills"] as unknown[]).length > 0;
  const startsWithSlash = /^\/[a-z0-9-]+/i.test(trimmed);
  const containsSkillMention = /\$[a-z0-9-]+/i.test(trimmed);

  if (hasSkillsArray || startsWithSlash || containsSkillMention) {
    return {
      messageId: message.id,
      sessionId: session.id,
      seq: message.seq,
      category: "organic_human_slash_or_skill_arg",
      isOrganic: true,
      text,
      reason: "Organic human slash command or skill invocation",
      timeCreated,
    };
  }

  // Subtype C: Standard composer human prompt
  return {
    messageId: message.id,
    sessionId: session.id,
    seq: message.seq,
    category: "organic_human_composer",
    isOrganic: true,
    text,
    reason: "Organic human prompt entered in composer",
    timeCreated,
  };
}

/**
 * Computes aggregate summary statistics for a collection of disambiguated messages.
 */
export function summarizeProvenance(messages: readonly DisambiguatedMessage[]): ProvenanceStats {
  const byCategory: Record<ProvenanceCategory, number> = {
    organic_human_composer: 0,
    organic_human_inline_comment: 0,
    organic_human_slash_or_skill_arg: 0,
    plugin_autogate_classifier: 0,
    subagent_child_session: 0,
    cloned_fork_history: 0,
    plugin_continuation_or_task_notification: 0,
    plugin_hindsight_survey: 0,
    openchamber_ui_magic_prompt: 0,
    openchamber_auto_review: 0,
    openchamber_ui_block_answer: 0,
    openchamber_reply_command_run: 0,
    openchamber_goal_continuation: 0,
    openchamber_agent_dispatch: 0,
    automated_harness_smoke_test: 0,
    empty_text_context_only_turn: 0,
  };

  let organicCount = 0;
  let syntheticCount = 0;

  for (const msg of messages) {
    byCategory[msg.category] = (byCategory[msg.category] ?? 0) + 1;
    if (msg.isOrganic) {
      organicCount++;
    } else {
      syntheticCount++;
    }
  }

  const totalAnalyzed = messages.length;
  const organicPercentage = totalAnalyzed > 0 ? (organicCount / totalAnalyzed) * 100 : 0;
  const syntheticPercentage = totalAnalyzed > 0 ? (syntheticCount / totalAnalyzed) * 100 : 0;

  return {
    totalAnalyzed,
    organicCount,
    syntheticCount,
    organicPercentage: Math.round(organicPercentage * 10) / 10,
    syntheticPercentage: Math.round(syntheticPercentage * 10) / 10,
    byCategory,
  };
}
