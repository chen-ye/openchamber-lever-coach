/**
 * Cross-session lever detectors producing human-reviewable proposals.
 * Never auto-applies file mutations or hooks.
 */

import { Database } from "bun:sqlite";
import { isOrganicCategory } from "./disambiguate.ts";
import type {
  DetectorRunResult,
  DisambiguatedMessage,
  ErrorRecoveryFinding,
  HarnessHealthFinding,
  LeverProposal,
  PromptCompressorFinding,
  SessionRecord,
  VerificationGapFinding,
} from "./types.ts";

export interface RelevantPartRow {
  readonly id: string;
  readonly session_id: string;
  readonly message_id?: string;
  readonly time_created: number;
  readonly data: string;
}

export interface ParsedToolPart {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId?: string;
  readonly timeCreated: number;
  readonly tool: string;
  readonly status?: string;
  readonly exit?: number;
  readonly error?: string | { readonly type?: string; readonly message?: string };
  readonly output?: string;
  readonly command?: string;
  readonly title?: string;
}

function parseErrorField(
  raw: unknown
): string | { readonly type?: string; readonly message?: string } | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        return {
          type: typeof obj["type"] === "string" ? obj["type"] : undefined,
          message: typeof obj["message"] === "string" ? obj["message"] : undefined,
        };
      } catch {}
    }
    return raw;
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    return {
      type: typeof obj["type"] === "string" ? obj["type"] : undefined,
      message: typeof obj["message"] === "string" ? obj["message"] : undefined,
    };
  }
  return undefined;
}

function getErrorText(error: ParsedToolPart["error"]): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    return `${error.type ?? ""} ${error.message ?? ""}`;
  }
  return "";
}

/**
 * Extracts normalized tool parts from either legacy v1 `part` table rows
 * or OpenCode v2 `session_message` (type = 'assistant') tool items.
 */
export function parseToolPartsFromRow(row: RelevantPartRow): ParsedToolPart[] {
  const results: ParsedToolPart[] = [];
  try {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;

    // Case 1: Legacy v1 `part` table row
    if (parsed["type"] === "tool") {
      const state = (parsed["state"] as Record<string, unknown> | undefined) ?? {};
      const input = (state["input"] as Record<string, unknown> | undefined) ?? {};
      const tool =
        typeof parsed["tool"] === "string"
          ? parsed["tool"]
          : typeof parsed["name"] === "string"
          ? parsed["name"]
          : "unknown";
      const status = typeof state["status"] === "string" ? state["status"] : undefined;
      const exit =
        typeof state["exit"] === "number"
          ? state["exit"]
          : typeof (state["metadata"] as Record<string, unknown> | undefined)?.["exit"] === "number"
          ? ((state["metadata"] as Record<string, unknown>)["exit"] as number)
          : undefined;

      let output = typeof state["output"] === "string" ? state["output"] : undefined;
      if (!output && Array.isArray(state["content"])) {
        output = (state["content"] as Array<Record<string, unknown>>)
          .map((c) => (typeof c["text"] === "string" ? c["text"] : ""))
          .join("\n");
      }

      const title = typeof state["title"] === "string" ? state["title"] : undefined;
      const command =
        typeof input["command"] === "string"
          ? input["command"]
          : typeof input["filePath"] === "string"
          ? input["filePath"]
          : title;

      const error = parseErrorField(state["error"]);

      results.push({
        id: row.id,
        sessionId: row.session_id,
        messageId: row.message_id,
        timeCreated: row.time_created,
        tool,
        status,
        exit,
        error,
        output,
        command,
        title,
      });
    }

    // Case 2: OpenCode v2 `session_message` (type = 'assistant') containing content[] tool items
    if (Array.isArray(parsed["content"])) {
      const contentList = parsed["content"] as Array<Record<string, unknown>>;
      for (let idx = 0; idx < contentList.length; idx++) {
        const item = contentList[idx]!;
        if (item["type"] === "tool") {
          const state = (item["state"] as Record<string, unknown> | undefined) ?? {};
          const input = (state["input"] as Record<string, unknown> | undefined) ?? {};
          const tool =
            typeof item["name"] === "string"
              ? item["name"]
              : typeof item["tool"] === "string"
              ? item["tool"]
              : "unknown";
          const status = typeof state["status"] === "string" ? state["status"] : undefined;
          const exit =
            typeof (state["metadata"] as Record<string, unknown> | undefined)?.["exit"] === "number"
              ? ((state["metadata"] as Record<string, unknown>)["exit"] as number)
              : typeof state["exit"] === "number"
              ? (state["exit"] as number)
              : undefined;

          let output = typeof state["output"] === "string" ? state["output"] : undefined;
          if (!output && Array.isArray(state["content"])) {
            output = (state["content"] as Array<Record<string, unknown>>)
              .map((c) => (typeof c["text"] === "string" ? c["text"] : ""))
              .join("\n");
          }

          const title = typeof state["title"] === "string" ? state["title"] : undefined;
          const command =
            typeof input["command"] === "string"
              ? input["command"]
              : typeof input["filePath"] === "string"
              ? input["filePath"]
              : title;

          const error = parseErrorField(state["error"]);

          const itemTime =
            typeof (item["time"] as Record<string, unknown> | undefined)?.["created"] === "number"
              ? ((item["time"] as Record<string, unknown>)["created"] as number)
              : row.time_created;

          results.push({
            id: typeof item["id"] === "string" ? item["id"] : `${row.id}_${idx}`,
            sessionId: row.session_id,
            messageId: row.id,
            timeCreated: itemTime,
            tool,
            status,
            exit,
            error,
            output,
            command,
            title,
          });
        }
      }
    }
  } catch {}

  return results;
}

// Backwards-compatible single-part parser
export function parseToolPart(row: RelevantPartRow): ParsedToolPart | null {
  const parts = parseToolPartsFromRow(row);
  return parts.length > 0 ? parts[0]! : null;
}

/**
 * Fast streaming filter that processes relevant rows across both legacy `part` table
 * and OpenCode v2 `session_message` (type = 'assistant') tool calls.
 */
export function fetchRelevantParts(
  db: Database,
  targetSessionIds?: readonly string[]
): readonly RelevantPartRow[] {
  const relevant: RelevantPartRow[] = [];
  const BATCH_SIZE = 400;

  const matchesAnyKeyword = (d: string) =>
    d.includes("Use 'fd'") ||
    d.includes("Use 'trash-put'") ||
    d.includes("GH_HOST") ||
    (d.includes("gh ") &&
      (d.includes("unknown host") ||
        d.includes("GraphQL") ||
        d.includes("Could not resolve") ||
        d.includes("exit"))) ||
    (d.includes("ssh ") && (d.includes("command not found") || d.includes("127"))) ||
    d.includes("EADDRINUSE") ||
    d.includes("unavailable tool") ||
    d.includes("classify_result") ||
    (d.includes("hindsight_ingest_document") && d.includes("500")) ||
    (d.includes("lsp_diagnostics") && d.includes("timeout")) ||
    d.includes("300 seconds") ||
    d.includes("permission.rejected");

  // If targetSessionIds is provided and reasonably sized (<= 4000), use fast indexed lookups
  if (targetSessionIds && targetSessionIds.length > 0 && targetSessionIds.length <= 4000) {
    for (let i = 0; i < targetSessionIds.length; i += BATCH_SIZE) {
      const batch = targetSessionIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");

      // 1. Indexed lookup in part table
      try {
        const pRows = db
          .query(
            `SELECT id, session_id, time_created, data FROM part WHERE session_id IN (${placeholders})`
          )
          .all(...batch) as RelevantPartRow[];
        for (const r of pRows) {
          if (matchesAnyKeyword(r.data)) relevant.push(r);
        }
      } catch {}

      // 2. Indexed lookup in session_message table (type = 'assistant')
      try {
        const mRows = db
          .query(
            `SELECT id, session_id, time_created, data FROM session_message WHERE session_id IN (${placeholders}) AND type = 'assistant'`
          )
          .all(...batch) as RelevantPartRow[];
        for (const r of mRows) {
          if (matchesAnyKeyword(r.data)) relevant.push(r);
        }
      } catch {}
    }

    // Return all relevant tool parts found in the target sessions
    return relevant;
  }

  // Fallback or large-scale full-table streaming scan using Bun's native iterator
  try {
    const qPart = db.query("SELECT id, session_id, time_created, data FROM part") as {
      iterate: () => IterableIterator<RelevantPartRow>;
    };
    for (const row of qPart.iterate()) {
      if (matchesAnyKeyword(row.data)) relevant.push(row);
    }
  } catch {}

  try {
    const qMsg = db.query(
      "SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant'"
    ) as { iterate: () => IterableIterator<RelevantPartRow> };
    for (const row of qMsg.iterate()) {
      if (matchesAnyKeyword(row.data)) relevant.push(row);
    }
  } catch {}

  return relevant;
}

/**
 * Detector 1: Error Recovery
 * Finds recurring failed tool calls (exit != 0 or guardrail errors) followed within 1–5 tool calls
 * in the same session by a working recovery command across sessions.
 */
export function runErrorRecoveryDetector(
  db: Database,
  targetSessionIds?: readonly string[],
  cachedParts?: readonly RelevantPartRow[]
): DetectorRunResult<ErrorRecoveryFinding> {
  const t0 = performance.now();

  const patterns = [
    {
      name: "find-guardrail-to-fd",
      triggerMatch: (part: ParsedToolPart) => {
        const err = getErrorText(part.error);
        const out = part.output ?? "";
        return err.includes("Use 'fd'") || out.includes("Use 'fd' instead of 'find'");
      },
      recoveryMatch: (part: ParsedToolPart) =>
        part.tool === "glob" ||
        ((part.tool === "bash" || part.tool === "shell") &&
          (part.command?.trim().startsWith("fd ") ?? false)),
      proposedLever:
        "Add shell alias `find() { fd \"$@\"; }` or install automatic AST command rewrite hook in ~/.omo/hooks.",
      severity: "medium" as const,
      description: "Guardrail blocked `find` in favor of `fd`",
    },
    {
      name: "rm-guardrail-to-trash-put",
      triggerMatch: (part: ParsedToolPart) => {
        const err = getErrorText(part.error);
        const out = part.output ?? "";
        return err.includes("Use 'trash-put'") || out.includes("Use 'trash-put' instead of 'rm'");
      },
      recoveryMatch: (part: ParsedToolPart) =>
        (part.tool === "bash" || part.tool === "shell") &&
        ((part.command?.includes("trash-put") ?? false) ||
          (part.command?.includes("Path.unlink") ?? false)),
      proposedLever:
        "Configure shell alias `alias rm='trash-put'` or configure policy allowlist rule for trash-put.",
      severity: "medium" as const,
      description: "Guardrail blocked `rm` in favor of `trash-put`",
    },
    {
      name: "gh-host-enterprise-fallback",
      triggerMatch: (part: ParsedToolPart) => {
        const isShell = part.tool === "bash" || part.tool === "shell";
        const isGh = part.command?.includes("gh ") ?? false;
        const err = getErrorText(part.error);
        const out = part.output ?? "";
        const isFail =
          (part.exit !== undefined && part.exit !== 0) ||
          out.includes("unknown host") ||
          out.includes("GraphQL") ||
          out.includes("Could not resolve to a Repository") ||
          err.includes("unknown host");
        return isShell && isGh && isFail;
      },
      recoveryMatch: (part: ParsedToolPart) =>
        (part.tool === "bash" || part.tool === "shell") &&
        ((part.command?.includes("GH_HOST=") ?? false) ||
          ((part.command?.includes("gh ") ?? false) &&
            (part.command?.includes("--hostname") ?? false))),
      proposedLever:
        "Export `export GH_HOST=<your-enterprise-host>` in user shell environment (`~/.bashrc` / `~/.zshrc`) and OpenCode environment variables.",
      severity: "high" as const,
      description: "GitHub CLI default host failure recovered via `GH_HOST` or `--hostname`",
    },
    {
      name: "ssh-remote-path-injection",
      triggerMatch: (part: ParsedToolPart) => {
        const isShell = part.tool === "bash" || part.tool === "shell";
        const isSsh = /\bssh\s+/.test(part.command ?? "");
        const err = getErrorText(part.error);
        const out = part.output ?? "";
        const isFail =
          part.exit === 127 ||
          out.includes("command not found") ||
          err.includes("command not found") ||
          out.includes("Exited with code 127");
        return isShell && isSsh && isFail;
      },
      recoveryMatch: (part: ParsedToolPart) =>
        (part.tool === "bash" || part.tool === "shell") &&
        ((part.command?.includes("mise") ?? false) ||
          (part.command?.includes(".local/share/mise") ?? false) ||
          (part.command?.includes("PATH=") ?? false)),
      proposedLever:
        "Create wrapper script or inject mise/user shims PATH in remote execution profiles: `export PATH=\"$HOME/.local/share/mise/shims:$PATH\"`.",
      severity: "high" as const,
      description: "Remote SSH Exit-127 (`command not found`) recovered via PATH/mise initialization",
    },
    {
      name: "dev-server-port-collision-eaddrinuse",
      triggerMatch: (part: ParsedToolPart) => {
        const out = part.output ?? "";
        const err = getErrorText(part.error);
        return out.includes("EADDRINUSE") || err.includes("EADDRINUSE");
      },
      recoveryMatch: (part: ParsedToolPart) =>
        (part.tool === "bash" || part.tool === "shell") &&
        ((part.command?.includes("kill ") ?? false) ||
          (part.command?.includes("pkill") ?? false) ||
          (part.command?.includes("fuser") ?? false) ||
          (part.command?.includes("PORT=") ?? false)),
      proposedLever:
        "Implement ephemeral port allocator or auto-kill lingering dev server instances before launching local harnesses.",
      severity: "medium" as const,
      description: "Local dev server EADDRINUSE port collisions recovered by process termination or port shift",
    },
  ];

  const partRows = cachedParts ?? fetchRelevantParts(db, targetSessionIds);

  // Extract all trigger candidate parts
  const triggerRows: ParsedToolPart[] = [];
  for (const r of partRows) {
    const parts = parseToolPartsFromRow(r);
    for (const p of parts) {
      for (const pat of patterns) {
        if (pat.triggerMatch(p)) {
          triggerRows.push(p);
          break;
        }
      }
    }
  }

  // Collect distinct session IDs from triggers
  const triggerSessionIds = Array.from(new Set(triggerRows.map((r) => r.sessionId)));
  const BATCH_SIZE = 400;

  // Query all tool parts for these trigger sessions across both part and session_message
  const sessionAllPartsMap = new Map<string, ParsedToolPart[]>();
  for (let i = 0; i < triggerSessionIds.length; i += BATCH_SIZE) {
    const batch = triggerSessionIds.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");

    // 1. Fetch from legacy part table
    try {
      const partSql = `
        SELECT id, session_id, time_created, data
        FROM part
        WHERE session_id IN (${placeholders})
        ORDER BY session_id, time_created ASC
      `;
      const fetchedParts = db.query(partSql).all(...batch) as RelevantPartRow[];
      for (const r of fetchedParts) {
        const parts = parseToolPartsFromRow(r);
        for (const parsed of parts) {
          let list = sessionAllPartsMap.get(parsed.sessionId);
          if (!list) {
            list = [];
            sessionAllPartsMap.set(parsed.sessionId, list);
          }
          list.push(parsed);
        }
      }
    } catch {}

    // 2. Fetch from v2 session_message table (type = 'assistant')
    try {
      const msgSql = `
        SELECT id, session_id, time_created, data
        FROM session_message
        WHERE session_id IN (${placeholders})
          AND type = 'assistant'
          AND data LIKE '%"type":"tool"%'
        ORDER BY session_id, seq ASC
      `;
      const fetchedMsgs = db.query(msgSql).all(...batch) as RelevantPartRow[];
      for (const r of fetchedMsgs) {
        const parts = parseToolPartsFromRow(r);
        for (const parsed of parts) {
          let list = sessionAllPartsMap.get(parsed.sessionId);
          if (!list) {
            list = [];
            sessionAllPartsMap.set(parsed.sessionId, list);
          }
          list.push(parsed);
        }
      }
    } catch {}
  }

  // Ensure parts are sorted by time within each session
  for (const list of sessionAllPartsMap.values()) {
    list.sort((a, b) => a.timeCreated - b.timeCreated);
  }

  const findingsMap = new Map<
    string,
    {
      occurrences: number;
      sessionIds: Set<string>;
      sampleTrigger: string;
      sampleRecovery: string;
      pattern: (typeof patterns)[number];
    }
  >();

  for (const pattern of patterns) {
    findingsMap.set(pattern.name, {
      occurrences: 0,
      sessionIds: new Set<string>(),
      sampleTrigger: "",
      sampleRecovery: "",
      pattern,
    });
  }

  // Correlate trigger -> recovery within 1–5 tool calls
  for (const p of triggerRows) {
    const sessionParts = sessionAllPartsMap.get(p.sessionId);
    if (!sessionParts) continue;

    const triggerIdx = sessionParts.findIndex((item) => item.id === p.id);
    if (triggerIdx === -1) continue;

    const subsequent = sessionParts.slice(triggerIdx + 1, triggerIdx + 6);
    for (const pattern of patterns) {
      if (pattern.triggerMatch(p)) {
        for (const nextPart of subsequent) {
          if (pattern.recoveryMatch(nextPart)) {
            const entry = findingsMap.get(pattern.name)!;
            entry.occurrences++;
            entry.sessionIds.add(p.sessionId);
            if (!entry.sampleTrigger) entry.sampleTrigger = p.command ?? p.tool;
            if (!entry.sampleRecovery) entry.sampleRecovery = nextPart.command ?? nextPart.tool;
            break;
          }
        }
      }
    }
  }

  const rawFindings: ErrorRecoveryFinding[] = [];
  const proposals: LeverProposal[] = [];

  for (const [name, entry] of findingsMap) {
    if (entry.occurrences > 0) {
      const finding: ErrorRecoveryFinding = {
        triggerPattern: name,
        exitOrError: entry.pattern.description,
        recoveryCommand: entry.sampleRecovery || entry.pattern.proposedLever,
        occurrences: entry.occurrences,
        sessionIds: Array.from(entry.sessionIds),
        proposedLever: entry.pattern.proposedLever,
      };
      rawFindings.push(finding);

      proposals.push({
        id: `prop-error-recovery-${name}`,
        title: `Error Recovery: ${entry.pattern.description}`,
        detector: "error-recovery",
        severity: entry.pattern.severity,
        frequency: entry.occurrences,
        affectedSessions: Array.from(entry.sessionIds).slice(0, 10),
        summary: `Encountered ${entry.occurrences} times across ${entry.sessionIds.size} sessions: initial failure was manually recovered within 1–5 tool calls.`,
        rationale: `Automating or aliasing this fix saves context turns and prevents recurring exit code / guardrail friction.`,
        proposedAction: entry.pattern.proposedLever,
        status: "review_pending",
        evidence: {
          pattern: name,
          sampleTrigger: entry.sampleTrigger,
          sampleRecovery: entry.sampleRecovery,
        },
      });
    }
  }

  const t1 = performance.now();
  return {
    detectorName: "error-recovery",
    findingsCount: rawFindings.length,
    proposals,
    rawFindings,
    executionTimeMs: Math.round(t1 - t0),
    summary: `Identified ${rawFindings.length} recurring error recovery patterns across ${sessionAllPartsMap.size} sessions.`,
  };
}

/**
 * Detector 2: Prompt Compressor
 * Operates strictly on disambiguated organic human prompts + ~/.gemini/policies/.policy_candidates.jsonl.
 * Clusters recurring organic human prompts and ad-hoc inline scripts.
 */
export async function runPromptCompressorDetector(
  disambiguatedMessages: readonly DisambiguatedMessage[],
  policiesPath?: string
): Promise<DetectorRunResult<PromptCompressorFinding>> {
  const t0 = performance.now();

  // Filter strictly to organic human prompts
  const organicMessages = disambiguatedMessages.filter((m) => isOrganicCategory(m.category));

  // 1. Cluster recurring organic prompts
  const clusters = [
    {
      name: "continuation-nudges",
      match: (t: string) =>
        /^(proceed|continue|go ahead|keep going|yes|next|proceed with changes|ok|yep|sure|do it)\.?$/i.test(
          t.trim()
        ),
      proposedLever:
        "Add `/proceed` quick slash command or configure auto-continuation policy for non-destructive step verification.",
    },
    {
      name: "git-commit-push-ceremony",
      match: (t: string) =>
        /(commit and push|git status|create pr|open a pr|push changes|push branch|git push)/i.test(t),
      proposedLever:
        "Introduce `/ship` command or pre-composed workflow combining commit message generation, push, and PR creation.",
    },
    {
      name: "manual-review-triggers",
      match: (t: string) =>
        /(review this|check the diff|inspect changes|review changes|run checks|run tests)/i.test(t),
      proposedLever:
        "Provide `/crit` or `/verify` hotkey trigger in workspace toolbar to invoke review pass without manual prompting.",
    },
    {
      name: "visual-verification-nudges",
      match: (t: string) =>
        /(take a screenshot|show me|look at the page|verify visually|check the ui|take screenshot)/i.test(t),
      proposedLever:
        "Provide automated visual verification skill hook that captures component screenshots on completion.",
    },
    {
      name: "prefix-directives",
      match: (t: string) =>
        /^(plan:|brainstorm:|analyze:|investigate:|fix:)/i.test(t.trim()),
      proposedLever:
        "Register prefix dispatcher mapping `plan:`, `brainstorm:`, and `analyze:` directly to specialized subagent profiles.",
    },
  ];

  const clusterStats = new Map<
    string,
    {
      count: number;
      sessions: Set<string>;
      samples: string[];
      proposedLever: string;
    }
  >();

  for (const c of clusters) {
    clusterStats.set(c.name, {
      count: 0,
      sessions: new Set<string>(),
      samples: [],
      proposedLever: c.proposedLever,
    });
  }

  for (const msg of organicMessages) {
    const text = msg.text.trim();
    for (const c of clusters) {
      if (c.match(text)) {
        const stat = clusterStats.get(c.name)!;
        stat.count++;
        stat.sessions.add(msg.sessionId);
        if (stat.samples.length < 3 && !stat.samples.includes(text)) {
          stat.samples.push(text.slice(0, 80));
        }
      }
    }
  }

  // 2. Parse ~/.gemini/policies/.policy_candidates.jsonl for ad-hoc inline scripts
  const scriptClusters = new Map<
    string,
    { count: number; samples: string[]; proposedLever: string }
  >([
    [
      "inline-python-json-script",
      {
        count: 0,
        samples: [],
        proposedLever:
          "Convert recurring `python3 -c` JSON/file manipulation one-liners into a dedicated CLI command in `tools/`.",
      },
    ],
    [
      "inline-bun-eval",
      {
        count: 0,
        samples: [],
        proposedLever:
          "Package recurring `bun -e` evaluation harnesses into standard test scripts or a reusable runner.",
      },
    ],
    [
      "inline-http-server",
      {
        count: 0,
        samples: [],
        proposedLever:
          "Provide a standardized local preview server helper script with deterministic port management.",
      },
    ],
  ]);

  if (policiesPath) {
    try {
      const file = Bun.file(policiesPath);
      if (await file.exists()) {
        const text = await file.text();
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const cmd = typeof parsed["command"] === "string" ? parsed["command"] : "";
            if (!cmd) continue;

            if (cmd.includes("python3 -c")) {
              const entry = scriptClusters.get("inline-python-json-script")!;
              entry.count++;
              if (entry.samples.length < 3) entry.samples.push(cmd.slice(0, 100));
            } else if (cmd.includes("bun -e") || cmd.includes("node -e")) {
              const entry = scriptClusters.get("inline-bun-eval")!;
              entry.count++;
              if (entry.samples.length < 3) entry.samples.push(cmd.slice(0, 100));
            } else if (cmd.includes("http.server") || cmd.includes("serve ")) {
              const entry = scriptClusters.get("inline-http-server")!;
              entry.count++;
              if (entry.samples.length < 3) entry.samples.push(cmd.slice(0, 100));
            }
          } catch {
            // Ignore malformed jsonl lines
          }
        }
      }
    } catch {
      // Ignore file read error if policies file is unreadable
    }
  }

  const rawFindings: PromptCompressorFinding[] = [];
  const proposals: LeverProposal[] = [];

  // Add organic prompt clusters
  for (const [name, stat] of clusterStats) {
    if (stat.count > 0) {
      rawFindings.push({
        cluster: name,
        clusterType: "organic_prompt",
        occurrences: stat.count,
        distinctSessions: stat.sessions.size,
        sampleTexts: stat.samples,
        proposedLever: stat.proposedLever,
      });

      proposals.push({
        id: `prop-prompt-compressor-${name}`,
        title: `Prompt Compressor: ${name.replace(/-/g, " ")}`,
        detector: "prompt-compressor",
        severity: stat.count >= 10 ? "high" : "medium",
        frequency: stat.count,
        affectedSessions: Array.from(stat.sessions).slice(0, 10),
        summary: `Found ${stat.count} organic human turns across ${stat.sessions.size} sessions repeating "${name}".`,
        rationale:
          "Replacing repetitive manual human prompts with shortcuts, dedicated slash commands, or automation saves cognitive overhead.",
        proposedAction: stat.proposedLever,
        status: "review_pending",
        evidence: {
          samples: stat.samples,
          totalOccurrences: stat.count,
        },
      });
    }
  }

  // Add ad-hoc script clusters
  for (const [name, stat] of scriptClusters) {
    if (stat.count > 0) {
      rawFindings.push({
        cluster: name,
        clusterType: "ad_hoc_script",
        occurrences: stat.count,
        distinctSessions: 1,
        sampleTexts: stat.samples,
        proposedLever: stat.proposedLever,
      });

      proposals.push({
        id: `prop-script-compressor-${name}`,
        title: `Script Compressor: ${name.replace(/-/g, " ")}`,
        detector: "prompt-compressor",
        severity: "medium",
        frequency: stat.count,
        affectedSessions: [],
        summary: `Found ${stat.count} ad-hoc inline script executions for "${name}".`,
        rationale:
          "Ad-hoc inline CLI commands (`python3 -c`, `bun -e`) are brittle and bypass project linting/testing; encapsulating them into stable tools improves reliability.",
        proposedAction: stat.proposedLever,
        status: "review_pending",
        evidence: {
          samples: stat.samples,
          totalOccurrences: stat.count,
        },
      });
    }
  }

  const t1 = performance.now();
  return {
    detectorName: "prompt-compressor",
    findingsCount: rawFindings.length,
    proposals,
    rawFindings,
    executionTimeMs: Math.round(t1 - t0),
    summary: `Clustered ${rawFindings.length} repetitive organic prompt and script patterns from ${organicMessages.length} organic messages.`,
  };
}

/**
 * Detector 3: Harness Health
 * Aggregates silent cross-session drags from opencode.db:
 * - unavailable tool 'invalid' broken down by tool name and agent profile
 * - classify_result leakage into non-AutoGate sessions
 * - hindsight_ingest_document /dev/shm HTTP 500s
 * - lsp_diagnostics timeouts
 * - AutoGate 300s review timeouts
 * - permission.rejected counts
 */
export function runHarnessHealthDetector(
  db: Database,
  sessionMap?: ReadonlyMap<string, SessionRecord>,
  cachedParts?: readonly RelevantPartRow[]
): DetectorRunResult<HarnessHealthFinding> {
  const t0 = performance.now();

  const rawFindings: HarnessHealthFinding[] = [];
  const proposals: LeverProposal[] = [];

  const partRows = cachedParts ?? fetchRelevantParts(db);

  const toolByAgentMap = new Map<string, number>();
  const classifyLeakByAgentMap = new Map<string, number>();
  let hindsight500Count = 0;
  let lspTimeoutCount = 0;
  let autogate300sTimeoutCount = 0;
  let permissionRejectedCount = 0;

  for (const row of partRows) {
    const data = row.data;

    // 1. Unavailable tool
    if (data.includes("unavailable tool")) {
      const match = /unavailable tool '([^']+)'/.exec(data);
      const attemptedTool = match && match[1] ? match[1] : "invalid";
      const session = sessionMap?.get(row.session_id);
      const agent = session?.agent || "default";
      const key = `${agent} -> ${attemptedTool}`;
      toolByAgentMap.set(key, (toolByAgentMap.get(key) ?? 0) + 1);
    }

    // 2. Classify_result leakage into non-AutoGate sessions
    if (data.includes("classify_result")) {
      const session = sessionMap?.get(row.session_id);
      const agent = session?.agent || "unspecified";
      if (agent !== "auto-gate-eval") {
        classifyLeakByAgentMap.set(agent, (classifyLeakByAgentMap.get(agent) ?? 0) + 1);
      }
    }

    // 3. Hindsight 500
    if (data.includes("hindsight_ingest_document") && data.includes("500")) {
      hindsight500Count++;
    }

    // 4. LSP timeout
    if (
      data.includes("lsp_diagnostics") &&
      (data.includes("timeout") || data.includes("timed out"))
    ) {
      lspTimeoutCount++;
    }

    // 5. AutoGate 300s review timeout
    if (data.includes("300 seconds") || data.includes("timed out after 300")) {
      autogate300sTimeoutCount++;
    }

    // 6. Permission rejected
    if (data.includes("permission.rejected") || data.includes('"status":"rejected"')) {
      permissionRejectedCount++;
    }
  }

  // Populate unavailable tool findings
  for (const [key, count] of toolByAgentMap) {
    if (count >= 5) {
      const [agent, tool] = key.split(" -> ") as [string, string];
      rawFindings.push({
        issueType: "unavailable_tool",
        identifier: key,
        agentOrTool: `${agent}:${tool}`,
        count,
        impactDescription: `Model under agent "${agent}" repeatedly tried to call unavailable tool "${tool}".`,
        proposedLever: `Verify agent configuration in ~/.omo/ or ~/.config/opencode/ to either register "${tool}" or refine system prompts to avoid hallucinated tool calls.`,
      });
    }
  }

  // Populate classify_result leakage findings
  for (const [agent, count] of classifyLeakByAgentMap) {
    if (count >= 2) {
      rawFindings.push({
        issueType: "classify_result_leakage",
        identifier: `leak-${agent}`,
        agentOrTool: agent,
        count,
        impactDescription: `AutoGate's internal 'classify_result' tool leaked into normal agent profile "${agent}" (${count} times).`,
        proposedLever: `Scope 'classify_result' tool exclusively to the 'auto-gate-eval' subagent in plugin tool definitions.`,
      });
    }
  }

  // Populate remaining health drag findings
  if (hindsight500Count > 0) {
    rawFindings.push({
      issueType: "hindsight_500",
      identifier: "hindsight_ingest_500",
      agentOrTool: "hindsight_ingest_document",
      count: hindsight500Count,
      impactDescription: `Hindsight document ingestion failed with HTTP 500 errors (${hindsight500Count} times), frequently tied to /dev/shm resource exhaustion.`,
      proposedLever: `Check Hindsight local service logs and ensure /dev/shm has sufficient space or fallback to /tmp/opencode.`,
    });
  }

  if (lspTimeoutCount > 0) {
    rawFindings.push({
      issueType: "lsp_timeout",
      identifier: "lsp_diagnostics_timeout",
      agentOrTool: "lsp_diagnostics",
      count: lspTimeoutCount,
      impactDescription: `Language server diagnostics timed out (${lspTimeoutCount} times), stalling agent completion turns.`,
      proposedLever: `Increase LSP client timeout in OpenCode settings or configure debounced diagnostic queries.`,
    });
  }

  if (autogate300sTimeoutCount > 0) {
    rawFindings.push({
      issueType: "autogate_300s_timeout",
      identifier: "autogate_review_timeout",
      agentOrTool: "auto-gate",
      count: autogate300sTimeoutCount,
      impactDescription: `AutoGate review requests timed out after 300 seconds (${autogate300sTimeoutCount} times) waiting for human approval.`,
      proposedLever: `Add pre-approved safe patterns to organized.toml / policy allowlists so routine read-only tools do not stall on interactive review.`,
    });
  }

  if (permissionRejectedCount > 0) {
    rawFindings.push({
      issueType: "permission_rejected",
      identifier: "permission_rejected_parts",
      agentOrTool: "permission_system",
      count: permissionRejectedCount,
      impactDescription: `Explicit permission rejections recorded (${permissionRejectedCount} times).`,
      proposedLever: `Review denied resources in policy management to ensure legitimate project paths are not blocked.`,
    });
  }

  // Build reviewable proposals
  for (const finding of rawFindings) {
    proposals.push({
      id: `prop-harness-health-${finding.identifier}`,
      title: `Harness Health: ${finding.issueType.replace(/_/g, " ")} (${finding.agentOrTool})`,
      detector: "harness-health",
      severity:
        finding.issueType === "classify_result_leakage" ||
        finding.issueType === "autogate_300s_timeout"
          ? "high"
          : "medium",
      frequency: finding.count,
      affectedSessions: [],
      summary: finding.impactDescription,
      rationale:
        "Silent harness drags degrade agent velocity, waste token budgets, and cause unexpected timeouts across sessions.",
      proposedAction: finding.proposedLever,
      status: "review_pending",
      evidence: {
        issueType: finding.issueType,
        count: finding.count,
      },
    });
  }

  const t1 = performance.now();
  return {
    detectorName: "harness-health",
    findingsCount: rawFindings.length,
    proposals,
    rawFindings,
    executionTimeMs: Math.round(t1 - t0),
    summary: `Audited harness health: found ${rawFindings.length} operational drag indicators across sessions.`,
  };
}

/**
 * Extracts complete assistant prose/reasoning text from session_message data.
 */
function extractAssistantText(data: Record<string, unknown>): string {
  if (typeof data["text"] === "string") return data["text"];
  if (Array.isArray(data["content"])) {
    return data["content"]
      .map((item: Record<string, unknown>) => {
        if (typeof item["text"] === "string") return item["text"];
        return "";
      })
      .join("\n");
  }
  return "";
}

/**
 * Detector 4: Verification Gap
 * Detects sessions where an assistant turn ran checks/tests or reported completion,
 * followed by >= 3 organic human correction turns in the same session containing
 * visual/geometric rejection signals.
 */
export function runVerificationGapDetector(
  db: Database,
  sessions: readonly SessionRecord[],
  disambiguatedMessages: readonly DisambiguatedMessage[]
): DetectorRunResult<VerificationGapFinding> {
  const t0 = performance.now();

  const rejectionPatterns = [
    /\[.*\.png\]/i,
    /\.png\b/i,
    /screenshot/i,
    /still wrong/i,
    /looks wrong/i,
    /opposite side/i,
    /turn radius/i,
    /still jumping/i,
    /why dont the/i,
    /why doesn'?t the/i,
    /misaligned/i,
    /inverted/i,
    /upside down/i,
    /broken rendering/i,
    /doesn'?t look right/i,
    /trumpet ramps? look wrong/i,
    /more parallel/i,
    /t markings/i,
    /transition angle/i,
    /loop size/i,
    /too tight/i,
    /visual oddity/i,
    /looks? weird/i,
    /looks? artificial/i,
    /incorrectly visually/i,
    /wrong approach/i,
  ];

  const completionMarkers = [
    "all checks pass",
    "tests pass",
    "passed all tests",
    "completed the task",
    "finished implementing",
    "changes are ready",
    "successfully implemented",
    "verification completed",
    "verification passed",
    "testing",
    "verified",
    "checks pass",
    "implemented",
    "validating",
    "ready for review",
  ];

  // Group disambiguated messages by session
  const sessionMessagesMap = new Map<string, DisambiguatedMessage[]>();
  for (const msg of disambiguatedMessages) {
    let list = sessionMessagesMap.get(msg.sessionId);
    if (!list) {
      list = [];
      sessionMessagesMap.set(msg.sessionId, list);
    }
    list.push(msg);
  }

  const sessionMap = new Map<string, SessionRecord>(sessions.map((s) => [s.id, s]));
  const rawFindings: VerificationGapFinding[] = [];
  const proposals: LeverProposal[] = [];

  for (const [sessionId, msgs] of sessionMessagesMap) {
    const session = sessionMap.get(sessionId);
    if (!session) continue;

    // Check if session has organic messages with rejection patterns (including organic inline comments)
    const organicMsgs = msgs.filter((m) => m.isOrganic);
    if (organicMsgs.length < 3) continue;

    const rejectionTurns: DisambiguatedMessage[] = [];
    const detectedSignals = new Set<string>();

    for (const org of organicMsgs) {
      let hasRejection = false;
      for (const pattern of rejectionPatterns) {
        if (pattern.test(org.text)) {
          hasRejection = true;
          detectedSignals.add(pattern.source.replace(/\\/g, ""));
        }
      }
      if (hasRejection) {
        rejectionTurns.push(org);
      }
    }

    if (rejectionTurns.length >= 3) {
      // Check if an assistant turn ran tests/checks or claimed completion earlier
      const assistantRows = db
        .query(
          `SELECT id, session_id, type, seq, time_created, data
           FROM session_message
           WHERE session_id = ? AND type = 'assistant'
           ORDER BY seq ASC`
        )
        .all(sessionId) as Array<{
          readonly id: string;
          readonly session_id: string;
          readonly seq: number;
          readonly data: string;
        }>;

      let completionSeq = -1;
      for (const asst of assistantRows) {
        try {
          const d = JSON.parse(asst.data) as Record<string, unknown>;
          const text = extractAssistantText(d).toLowerCase();
          for (const marker of completionMarkers) {
            if (text.includes(marker)) {
              completionSeq = asst.seq;
              break;
            }
          }
          if (completionSeq !== -1) break;
        } catch {
          continue;
        }
      }

      if (completionSeq !== -1) {
        const finding: VerificationGapFinding = {
          sessionId,
          sessionTitle: session.title || "Untitled Session",
          completionTurnSeq: completionSeq,
          correctionTurnsCount: rejectionTurns.length,
          rejectionSignals: Array.from(detectedSignals),
          sampleCorrections: rejectionTurns.slice(0, 3).map((t) => t.text.slice(0, 100)),
          proposedInvariantCheckLever:
            "Generate a dedicated invariant verification script (e.g. headless Playwright visual check or geometric property test) that validates visual/spatial state before reporting completion.",
        };
        rawFindings.push(finding);

        proposals.push({
          id: `prop-verification-gap-${sessionId}`,
          title: `Verification Gap: ${session.title || sessionId}`,
          detector: "verification-gap",
          severity: "high",
          frequency: rejectionTurns.length,
          affectedSessions: [sessionId],
          summary: `Assistant ran checks/completion at seq ${completionSeq}, but user submitted ${rejectionTurns.length} subsequent corrections with visual/geometric rejection signals (${Array.from(detectedSignals).slice(0, 4).join(", ")}).`,
          rationale:
            "Tests passed syntactically, but visual or geometric invariants were broken, forcing multiple human intervention cycles.",
          proposedAction: finding.proposedInvariantCheckLever,
          status: "review_pending",
          evidence: {
            sessionId,
            rejectionSignals: Array.from(detectedSignals),
            sampleCorrections: finding.sampleCorrections,
          },
        });
      }
    }
  }

  const t1 = performance.now();
  return {
    detectorName: "verification-gap",
    findingsCount: rawFindings.length,
    proposals,
    rawFindings,
    executionTimeMs: Math.round(t1 - t0),
    summary: `Analyzed ${sessionMessagesMap.size} sessions for premature completion claims: found ${rawFindings.length} sessions with >= 3 visual/geometric rejection cycles.`,
  };
}
