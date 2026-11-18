/**
 * lever-coach test suite
 * Tests prompt provenance disambiguation and all 4 lever detectors.
 */

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  classifyPromptProvenance,
  extractInlineCommentText,
  isOrganicCategory,
  summarizeProvenance,
} from "../src/disambiguate.ts";
import {
  runErrorRecoveryDetector,
  runHarnessHealthDetector,
  runPromptCompressorDetector,
  runVerificationGapDetector,
} from "../src/detectors.ts";
import { runAnalysis } from "../src/cli.ts";
import type { MessageRecord, SessionRecord } from "../src/types.ts";

function createMockSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "ses_test_001",
    project_id: "proj_001",
    parent_id: null,
    title: "Test Session",
    agent: null,
    model: "claude-3-5-sonnet",
    directory: "/tmp/test",
    time_created: 1000,
    time_updated: 2000,
    metadata: null,
    ...overrides,
  };
}

function createMockMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg_norm001",
    session_id: "ses_test_001",
    type: "user",
    seq: 1,
    time_created: 1100,
    time_updated: 1100,
    data: {
      text: "Hello assistant",
    },
    ...overrides,
  };
}

describe("Prompt Provenance Disambiguation", () => {
  it("never misclassifies OpenChamber Magic Prompts as organic human prompts", () => {
    const magicPrefixes = [
      "Implement this plan: World Generation Redesign",
      "Improve this plan: Refactor memory subsystem",
      "Prepare a handoff for another agent to review this work.",
      "Review the changes made in this workspace.",
      "Summarize this session focused on architectural changes.",
      "Tidy up my memory: drop what is outdated, merge duplicates, and fix what has changed.",
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
      "You are generating a Conventional Commits subject line from the diffs",
      "You are drafting a GitHub pull request title and body",
      "Investigate the merge conflicts and concisely report the intended resolution strategy",
      "Resolve cherry-pick conflicts, stage the resolved files, and continue the cherry-pick.",
    ];

    const session = createMockSession();
    for (const prefix of magicPrefixes) {
      const msg = createMockMessage({ data: { text: prefix } });
      const classified = classifyPromptProvenance(msg, session, null);
      expect(classified.category).toBe("openchamber_ui_magic_prompt");
      expect(classified.isOrganic).toBe(false);
      expect(isOrganicCategory(classified.category)).toBe(false);
    }
  });

  it("detects Magic Prompt instructions in preceding seq - 1 synthetic messages", () => {
    const session = createMockSession();
    const precedingSynthetic = createMockMessage({
      type: "synthetic",
      seq: 1,
      data: {
        text: "You are starting from an existing implementation plan.\nPlan title: Foo\nRead that file first...",
      },
    });

    const userPrompt = createMockMessage({
      type: "user",
      seq: 2,
      data: { text: "Arbitrary customized plan title without standard prefix" },
    });

    const classified = classifyPromptProvenance(userPrompt, session, precedingSynthetic);
    expect(classified.category).toBe("openchamber_ui_magic_prompt");
    expect(classified.isOrganic).toBe(false);
  });

  it("classifies AutoGate classifiers and subagents as synthetic", () => {
    const autoGateSession = createMockSession({ agent: "auto-gate-eval" });
    const msg = createMockMessage({ data: { text: "Evaluate permission for bash tool" } });
    const classified = classifyPromptProvenance(msg, autoGateSession, null);
    expect(classified.category).toBe("plugin_autogate_classifier");
    expect(classified.isOrganic).toBe(false);

    const childSession = createMockSession({ parent_id: "ses_parent_123" });
    const childMsg = createMockMessage({ data: { text: "Subagent instructions" } });
    const childClassified = classifyPromptProvenance(childMsg, childSession, null);
    expect(childClassified.category).toBe("subagent_child_session");
    expect(childClassified.isOrganic).toBe(false);

    const exploreSession = createMockSession({ agent: "explore" });
    const exploreClassified = classifyPromptProvenance(childMsg, exploreSession, null);
    expect(exploreClassified.category).toBe("subagent_child_session");
    expect(exploreClassified.isOrganic).toBe(false);
  });

  it("detects cloned fork history by patterned message id or pre-session timestamp", () => {
    const session = createMockSession({ time_created: 5000 });

    const clonedIdMsg = createMockMessage({
      id: "msg_abc123_0",
      time_created: 5500,
      data: { text: "Historic prompt" },
    });
    expect(classifyPromptProvenance(clonedIdMsg, session, null).category).toBe("cloned_fork_history");

    const preSessionTimeMsg = createMockMessage({
      id: "msg_normal",
      time_created: 3000, // Older than session.time_created (5000)
      data: { text: "Historic prompt from prior fork branch" },
    });
    expect(classifyPromptProvenance(preSessionTimeMsg, session, null).category).toBe("cloned_fork_history");
  });

  it("classifies OpenChamber UI block answers, reply commands, and agent handoffs", () => {
    const session = createMockSession();

    const uiBlockMsg = createMockMessage({
      data: {
        text: "The user answered the UI block in your previous reply:\n- Option A selected",
        metadata: {
          openchamberUiBlockAnswer: { messageId: "msg_1", block: "b1", answer: {} },
        },
      },
    });
    expect(classifyPromptProvenance(uiBlockMsg, session, null).category).toBe("openchamber_ui_block_answer");

    const replyCmdMsg = createMockMessage({
      data: {
        text: "Run this command in the project directory:\ngit status",
        metadata: { openchamberReplyCommand: true },
      },
    });
    expect(classifyPromptProvenance(replyCmdMsg, session, null).category).toBe("openchamber_reply_command_run");

    const dispatchMsg = createMockMessage({
      data: {
        text: "This message below comes from an AI agent in another session. Here is the content of the message:\nFoo",
        metadata: { openchamber: { promptedBy: "ses_prev" } },
      },
    });
    expect(classifyPromptProvenance(dispatchMsg, session, null).category).toBe("openchamber_agent_dispatch");
  });

  it("classifies plugin directives and goal continuation triggers", () => {
    const session = createMockSession();

    const omoDirective = createMockMessage({
      data: {
        text: "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]\nIncomplete tasks remain...",
      },
    });
    expect(classifyPromptProvenance(omoDirective, session, null).category).toBe(
      "plugin_continuation_or_task_notification"
    );

    const goalContinuation = createMockMessage({
      data: {
        text: "The session goal is still open. Take it through to the end in this run.",
      },
    });
    expect(classifyPromptProvenance(goalContinuation, session, null).category).toBe(
      "openchamber_goal_continuation"
    );
  });

  it("classifies OpenChamber inline comments in synthetic turns as organic_human_inline_comment", () => {
    const session = createMockSession();

    // Case 1: synthetic turn with Comment on ... quote
    const syntheticInlineMsg = createMockMessage({
      type: "synthetic",
      data: {
        text: "Comment on this fragment of an earlier message in this conversation:\n> `s/omp/src/evaluator.ts`): Wrap `completeSimple` with a 15-second AbortSignal.\n\nno, the timeout needs to be at least 40 sec",
      },
    });
    const c1 = classifyPromptProvenance(syntheticInlineMsg, session, null);
    expect(c1.category).toBe("organic_human_inline_comment");
    expect(c1.isOrganic).toBe(true);
    expect(c1.text).toBe("no, the timeout needs to be at least 40 sec");

    // Case 2: metadata.openchamberContext object
    const contextMsg = createMockMessage({
      type: "synthetic",
      data: {
        text: "Comment on this fragment of an earlier message in this conversation:\n> E2E test assertion mismatch\n\nfix this test mismatch",
        metadata: {
          openchamberContext: {
            kind: "chat-quote",
            text: "fix this test mismatch",
          },
        },
      },
    });
    const c2 = classifyPromptProvenance(contextMsg, session, null);
    expect(c2.category).toBe("organic_human_inline_comment");
    expect(c2.isOrganic).toBe(true);
    expect(c2.text).toBe("fix this test mismatch");
  });

  it("classifies skill mentions and slash commands as organic_human_slash_or_skill_arg", () => {
    const session = createMockSession();

    // Skill array
    const skillArrayMsg = createMockMessage({
      data: {
        skills: [{ id: "typescript-best-practices", name: "typescript-best-practices" }],
        text: "plan: improve the types",
      },
    });
    const c1 = classifyPromptProvenance(skillArrayMsg, session, null);
    expect(c1.category).toBe("organic_human_slash_or_skill_arg");
    expect(c1.isOrganic).toBe(true);

    // Dollar-prefixed skill mention
    const dollarSkillMsg = createMockMessage({
      data: { text: "review the config inspector ui holistically $impeccable" },
    });
    const c2 = classifyPromptProvenance(dollarSkillMsg, session, null);
    expect(c2.category).toBe("organic_human_slash_or_skill_arg");
    expect(c2.isOrganic).toBe(true);

    // Standard slash command
    const slashMsg = createMockMessage({
      data: { text: "/crit inspect recent changes against SDP 2.0" },
    });
    const c3 = classifyPromptProvenance(slashMsg, session, null);
    expect(c3.category).toBe("organic_human_slash_or_skill_arg");
    expect(c3.isOrganic).toBe(true);

    // Auto-gate control must be filtered out
    const autoGateControlMsg = createMockMessage({
      data: { text: "[auto-gate control] review pending" },
    });
    const c4 = classifyPromptProvenance(autoGateControlMsg, session, null);
    expect(c4.category).toBe("plugin_autogate_classifier");
    expect(c4.isOrganic).toBe(false);

    // Empty auto-slash-command instruction wrapper must be filtered out
    const wrapperMsg = createMockMessage({
      data: { text: "<auto-slash-command>\n# /start-work Command\n</auto-slash-command>\n<user-request>\n</user-request>" },
    });
    const c5 = classifyPromptProvenance(wrapperMsg, session, null);
    expect(c5.category).toBe("plugin_continuation_or_task_notification");
    expect(c5.isOrganic).toBe(false);
  });

  it("extracts inline comment text cleanly", () => {
    const full =
      "Comment on this fragment of an earlier message in this conversation:\n> line 1\n> line 2\n\nplease update the return type";
    expect(extractInlineCommentText(full)).toBe("please update the return type");

    const withMeta = extractInlineCommentText(full, {
      openchamberContext: { text: "meta text override" },
    });
    expect(withMeta).toBe("meta text override");
  });

  it("computes summary statistics accurately", () => {
    const session = createMockSession();
    const msgs = [
      classifyPromptProvenance(createMockMessage({ data: { text: "Organic 1" } }), session, null),
      classifyPromptProvenance(createMockMessage({ data: { text: "Organic 2" } }), session, null),
      classifyPromptProvenance(
        createMockMessage({ data: { text: "Implement this plan: Foo" } }),
        session,
        null
      ),
      classifyPromptProvenance(
        createMockMessage({
          data: {
            text: "The user answered the UI block in your previous reply: ok",
            metadata: { openchamberUiBlockAnswer: {} },
          },
        }),
        session,
        null
      ),
    ];

    const stats = summarizeProvenance(msgs);
    expect(stats.totalAnalyzed).toBe(4);
    expect(stats.organicCount).toBe(2);
    expect(stats.syntheticCount).toBe(2);
    expect(stats.organicPercentage).toBe(50);
    expect(stats.syntheticPercentage).toBe(50);
    expect(stats.byCategory["organic_human_composer"]).toBe(2);
    expect(stats.byCategory["openchamber_ui_magic_prompt"]).toBe(1);
    expect(stats.byCategory["openchamber_ui_block_answer"]).toBe(1);
  });
});

describe("Cross-Session Detectors", () => {
  it("Detector 1 (Error Recovery): detects all 5 failure and recovery patterns in v2 assistant tools", () => {
    const memoryDb = new Database(":memory:");
    memoryDb.run(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      )
    `);
    memoryDb.run(`
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        seq INTEGER,
        time_created INTEGER,
        data TEXT
      )
    `);

    // 1. find-guardrail-to-fd in part table
    memoryDb.run(`INSERT INTO part VALUES (?, ?, ?, ?)`, [
      "part_1",
      "ses_find",
      1000,
      JSON.stringify({
        type: "tool",
        tool: "bash",
        state: { status: "error", error: "Use 'fd' instead of 'find'.", title: "find . -name foo" },
      }),
    ]);
    memoryDb.run(`INSERT INTO part VALUES (?, ?, ?, ?)`, [
      "part_2",
      "ses_find",
      1010,
      JSON.stringify({
        type: "tool",
        tool: "shell",
        state: { status: "completed", input: { command: "fd foo" }, title: "fd foo" },
      }),
    ]);

    // 2. ssh-remote-path-injection in session_message (v2)
    memoryDb.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
      "msg_rpic_1",
      "ses_rpic",
      "assistant",
      1,
      2000,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_rpic_fail",
            name: "shell",
            state: {
              status: "error",
              input: { command: "ssh user@remote.example.com 'uv tool install foo'" },
              content: [{ type: "text", text: "bash: line 6: uv: command not found\nExited with code 127" }],
              metadata: { exit: 127 },
            },
          },
        ],
      }),
    ]);
    memoryDb.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
      "msg_rpic_2",
      "ses_rpic",
      "assistant",
      2,
      2010,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_rpic_recover",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "ssh user@remote.example.com 'export PATH=$HOME/.local/share/mise/shims:$PATH'" },
              content: [{ type: "text", text: "success" }],
              metadata: { exit: 0 },
            },
          },
        ],
      }),
    ]);

    // 3. gh-host-enterprise-fallback in session_message (v2)
    memoryDb.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
      "msg_gh_1",
      "ses_gh",
      "assistant",
      1,
      3000,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_gh_fail",
            name: "shell",
            state: {
              status: "error",
              input: { command: "gh pr list" },
              content: [{ type: "text", text: "unknown host github.com" }],
              metadata: { exit: 1 },
            },
          },
        ],
      }),
    ]);
    memoryDb.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
      "msg_gh_2",
      "ses_gh",
      "assistant",
      2,
      3010,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_gh_recover",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "GH_HOST=git.example.com gh pr list" },
              content: [{ type: "text", text: "PR list" }],
              metadata: { exit: 0 },
            },
          },
        ],
      }),
    ]);

    // 4. rm-guardrail-to-trash-put in session_message (v2)
    memoryDb.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
      "msg_rm_1",
      "ses_rm",
      "assistant",
      1,
      4000,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_rm_fail",
            name: "shell",
            state: {
              status: "error",
              input: { command: "rm -f /tmp/test.png" },
              error: JSON.stringify({ type: "unknown", message: "Use 'trash-put' instead of 'rm'." }),
            },
          },
        ],
      }),
    ]);
    memoryDb.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
      "msg_rm_2",
      "ses_rm",
      "assistant",
      2,
      4010,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_rm_recover",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "trash-put /tmp/test.png" },
            },
          },
        ],
      }),
    ]);

    // 5. dev-server-port-collision-eaddrinuse in session_message (v2)
    memoryDb.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
      "msg_port_1",
      "ses_port",
      "assistant",
      1,
      5000,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_port_fail",
            name: "shell",
            state: {
              status: "error",
              input: { command: "bun run dev" },
              content: [{ type: "text", text: "Error: listen EADDRINUSE: address already in use :::3000" }],
            },
          },
        ],
      }),
    ]);
    memoryDb.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
      "msg_port_2",
      "ses_port",
      "assistant",
      2,
      5010,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_port_recover",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "kill 12345" },
            },
          },
        ],
      }),
    ]);

    const res = runErrorRecoveryDetector(memoryDb);
    expect(res.findingsCount).toBe(5);
    const proposalIds = res.proposals.map((p) => p.id);
    expect(proposalIds).toContain("prop-error-recovery-find-guardrail-to-fd");
    expect(proposalIds).toContain("prop-error-recovery-rm-guardrail-to-trash-put");
    expect(proposalIds).toContain("prop-error-recovery-gh-host-enterprise-fallback");
    expect(proposalIds).toContain("prop-error-recovery-ssh-remote-path-injection");
    expect(proposalIds).toContain("prop-error-recovery-dev-server-port-collision-eaddrinuse");
    memoryDb.close();
  });

  it("Detector 2 (Prompt Compressor): clusters organic prompts and ad-hoc scripts", async () => {
    const session = createMockSession();
    const organicPrompts = [
      classifyPromptProvenance(createMockMessage({ data: { text: "proceed" } }), session, null),
      classifyPromptProvenance(createMockMessage({ data: { text: "proceed" } }), session, null),
      classifyPromptProvenance(createMockMessage({ data: { text: "continue" } }), session, null),
      classifyPromptProvenance(createMockMessage({ data: { text: "commit and push" } }), session, null),
      classifyPromptProvenance(createMockMessage({ data: { text: "take a screenshot" } }), session, null),
      classifyPromptProvenance(createMockMessage({ data: { text: "plan: user auth redesign" } }), session, null),
    ];

    const syntheticMsg = classifyPromptProvenance(
      createMockMessage({ data: { text: "Implement this plan: proceed" } }),
      session,
      null
    );
    const allMsgs = [...organicPrompts, syntheticMsg];

    const res = await runPromptCompressorDetector(allMsgs);
    expect(res.findingsCount).toBeGreaterThan(0);
    const proposalIds = res.proposals.map((p) => p.id);
    expect(proposalIds).toContain("prop-prompt-compressor-continuation-nudges");
    expect(proposalIds).toContain("prop-prompt-compressor-git-commit-push-ceremony");
    expect(proposalIds).toContain("prop-prompt-compressor-visual-verification-nudges");
    expect(proposalIds).toContain("prop-prompt-compressor-prefix-directives");
  });

  it("Detector 3 (Harness Health): aggregates silent drag counts", () => {
    const memoryDb = new Database(":memory:");
    memoryDb.run(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      )
    `);
    memoryDb.run(`
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        seq INTEGER,
        time_created INTEGER,
        data TEXT
      )
    `);

    // Insert invalid tool errors
    for (let i = 0; i < 6; i++) {
      memoryDb.run(
        `INSERT INTO part VALUES (?, ?, ?, ?)`,
        [
          `part_inv_${i}`,
          "ses_1",
          1000 + i,
          JSON.stringify({
            type: "tool",
            tool: "invalid",
            data: "The arguments provided to the tool are invalid: Model tried to call unavailable tool 'invalid'.",
          }),
        ]
      );
    }

    const sessionMap = new Map<string, SessionRecord>([
      ["ses_1", createMockSession({ id: "ses_1", agent: "builder" })],
    ]);

    const res = runHarnessHealthDetector(memoryDb, sessionMap);
    expect(res.findingsCount).toBeGreaterThanOrEqual(1);
    const proposalIds = res.proposals.map((p) => p.id);
    expect(proposalIds).toContain("prop-harness-health-builder -> invalid");
    memoryDb.close();
  });

  it("Detector 4 (Verification Gap): detects assistant completion followed by highway / geometric rejection loop", () => {
    const memoryDb = new Database(":memory:");
    memoryDb.run(`
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        seq INTEGER,
        time_created INTEGER,
        data TEXT
      )
    `);

    const sessionId = "ses_highway_test";
    const session = createMockSession({ id: sessionId, title: "Highway layout and overpasses" });

    // Assistant claims completion at seq 2
    memoryDb.run(
      `INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "msg_asst_1",
        sessionId,
        "assistant",
        2,
        1000,
        JSON.stringify({
          content: [
            { type: "text", text: "Finished implementing trumpet interchange! All checks pass and verified." },
          ],
        }),
      ]
    );

    // Human submits subsequent correction turns with visual rejection signals
    const userMsg1 = createMockMessage({
      session_id: sessionId,
      seq: 3,
      data: { text: "trumpet ramps look wrong [Screenshot_20261109-152741.png](/tmp/check.png)" },
    });
    const userMsg2 = createMockMessage({
      session_id: sessionId,
      seq: 4,
      data: { text: "basic geometry is correct but i expect a smoother transition angle, loop size is too tight" },
    });
    const userMsg3 = createMockMessage({
      session_id: sessionId,
      seq: 5,
      data: { text: "mm, outer loop has too tight of a turn radius now. why dont the t markings align?" },
    });

    const disambiguated = [
      classifyPromptProvenance(userMsg1, session, null),
      classifyPromptProvenance(userMsg2, session, null),
      classifyPromptProvenance(userMsg3, session, null),
    ];

    const res = runVerificationGapDetector(memoryDb, [session], disambiguated);
    expect(res.findingsCount).toBe(1);
    expect(res.proposals.length).toBe(1);
    expect(res.proposals[0]!.id).toBe(`prop-verification-gap-${sessionId}`);
    expect(res.proposals[0]!.severity).toBe("high");
    expect(res.proposals[0]!.status).toBe("review_pending");
    memoryDb.close();
  });
});

describe("Integration Test against real opencode.db", () => {
  it(
    "runs full analysis with readonly access and includes organic inline comments",
    async () => {
      const realDbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
      const realPoliciesPath = join(homedir(), ".gemini", "policies", ".policy_candidates.jsonl");

      const report = await runAnalysis({
        dbPath: realDbPath,
        policiesPath: realPoliciesPath,
        detector: "all",
        days: 30,
        limit: 1000,
      });

      expect(report.sessionCount).toBeGreaterThan(0);
      expect(report.provenanceStats.totalAnalyzed).toBeGreaterThan(0);
      expect(report.results["prompt-compressor"]).toBeDefined();
      expect(report.results["harness-health"]).toBeDefined();

      for (const res of Object.values(report.results)) {
        if (res && res.proposals) {
          for (const p of res.proposals) {
            expect(p.status).toBe("review_pending");
          }
        }
      }
    },
    15000
  );
});
