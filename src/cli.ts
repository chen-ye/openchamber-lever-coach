#!/usr/bin/env bun
/**
 * lever-coach CLI
 * Agent- and human-friendly CLI for cross-session execution analysis and reviewable lever proposals.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  classifyPromptProvenance,
  summarizeProvenance,
} from "./disambiguate.ts";
import {
  fetchRelevantParts,
  runErrorRecoveryDetector,
  runHarnessHealthDetector,
  runPromptCompressorDetector,
  runVerificationGapDetector,
} from "./detectors.ts";
import type {
  AnalysisOptions,
  AnalysisReport,
  DetectorName,
  DetectorRunResult,
  DisambiguatedMessage,
  MessageData,
  MessageRecord,
  SessionRecord,
} from "./types.ts";

function printHelp(): void {
  console.log(`
\x1b[1mLEVER COACH\x1b[0m — Cross-session execution analyzer & reviewable lever advisor

\x1b[1mUSAGE:\x1b[0m
  bun run src/cli.ts [OPTIONS]

\x1b[1mOPTIONS:\x1b[0m
  --detector <name>   Detector to run (all | disambiguation | error-recovery | prompt-compressor | harness-health | verification-gap)
                      Default: all
  --json              Output analysis report as JSON
  --db <path>         Path to opencode.db (opened strictly readonly)
                      Default: ~/.local/share/opencode/opencode.db
  --policies <path>   Path to .policy_candidates.jsonl
                      Default: ~/.gemini/policies/.policy_candidates.jsonl
  --days <N>          Filter sessions created in the last N days (0 for all time)
                      Default: 30
  --limit <N>         Maximum sessions to analyze (0 for unlimited)
                      Default: 2000
  --help, -h          Show this help message

\x1b[1mEXAMPLES:\x1b[0m
  bun run src/cli.ts
  bun run src/cli.ts --detector error-recovery
  bun run src/cli.ts --detector harness-health --json
  bun run src/cli.ts --days 7 --limit 500
`);
}

function parseCliArgs(args: readonly string[]): AnalysisOptions & { readonly help?: boolean } {
  const options: {
    detector?: DetectorName | "all";
    json?: boolean;
    dbPath?: string;
    policiesPath?: string;
    days?: number;
    limit?: number;
    help?: boolean;
  } = {
    detector: "all",
    json: false,
    days: 30,
    limit: 2000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--detector" && i + 1 < args.length) {
      const d = args[++i]!;
      if (
        d === "all" ||
        d === "disambiguation" ||
        d === "error-recovery" ||
        d === "prompt-compressor" ||
        d === "harness-health" ||
        d === "verification-gap"
      ) {
        options.detector = d;
      }
    } else if (arg === "--db" && i + 1 < args.length) {
      options.dbPath = args[++i];
    } else if (arg === "--policies" && i + 1 < args.length) {
      options.policiesPath = args[++i];
    } else if (arg === "--days" && i + 1 < args.length) {
      const parsed = parseInt(args[++i]!, 10);
      if (!isNaN(parsed)) options.days = parsed;
    } else if (arg === "--limit" && i + 1 < args.length) {
      const parsed = parseInt(args[++i]!, 10);
      if (!isNaN(parsed)) options.limit = parsed;
    }
  }

  return options;
}

interface RawSessionRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly parent_id: string | null;
  readonly title: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly directory: string | null;
  readonly time_created: number;
  readonly time_updated: number | null;
  readonly metadata: string | null;
}

interface RawMessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly type: string;
  readonly seq: number;
  readonly time_created: number;
  readonly time_updated: number | null;
  readonly data: string;
}

export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisReport> {
  const overallStart = performance.now();

  const defaultDbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const defaultPoliciesPath = join(homedir(), ".gemini", "policies", ".policy_candidates.jsonl");

  const dbPath = options.dbPath || defaultDbPath;
  const policiesPath = options.policiesPath || defaultPoliciesPath;
  const days = options.days ?? 30;
  const limit = options.limit ?? 2000;
  const detector = options.detector ?? "all";

  // MUST DO: Open strictly in readonly mode
  const db = new Database(dbPath, { readonly: true });

  try {
    // 1. Fetch sessions bounded by days and limit
    let sessionSql = "SELECT id, project_id, parent_id, title, agent, model, directory, time_created, time_updated, metadata FROM session_v2";
    const sessionParams: SQLQueryBindings[] = [];

    if (days > 0) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      sessionSql += " WHERE time_created >= ?";
      sessionParams.push(cutoff);
    }
    sessionSql += " ORDER BY time_created DESC";
    if (limit > 0) {
      sessionSql += " LIMIT ?";
      sessionParams.push(limit);
    }

    const rawSessions = db.query(sessionSql).all(...sessionParams) as RawSessionRow[];
    const sessions: SessionRecord[] = rawSessions.map((r) => {
      let meta: Record<string, unknown> | null = null;
      if (r.metadata) {
        try {
          meta = JSON.parse(r.metadata) as Record<string, unknown>;
        } catch {}
      }
      return {
        id: r.id,
        project_id: r.project_id,
        parent_id: r.parent_id,
        title: r.title,
        agent: r.agent,
        model: r.model,
        directory: r.directory,
        time_created: r.time_created,
        time_updated: r.time_updated,
        metadata: meta,
      };
    });

    const sessionIds = sessions.map((s) => s.id);
    const sessionMap = new Map<string, SessionRecord>(sessions.map((s) => [s.id, s]));

    // 2. Fetch messages in batches to leverage indexed lookups
    const disambiguatedMessages: DisambiguatedMessage[] = [];
    const BATCH_SIZE = 400;

    for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
      const batchIds = sessionIds.slice(i, i + BATCH_SIZE);
      const placeholders = batchIds.map(() => "?").join(",");
      const messageSql = `
        SELECT id, session_id, type, seq, time_created, time_updated, data
        FROM session_message
        WHERE session_id IN (${placeholders})
          AND type IN ('user', 'synthetic')
        ORDER BY session_id, seq ASC
      `;
      const rawMessages = db.query(messageSql).all(...batchIds) as RawMessageRow[];

      // Group by session to resolve seq - 1 preceding message
      const sessionMsgMap = new Map<string, MessageRecord[]>();
      for (const rm of rawMessages) {
        let parsedData: MessageData = {};
        try {
          parsedData = JSON.parse(rm.data) as MessageData;
        } catch {}

        const msgRecord: MessageRecord = {
          id: rm.id,
          session_id: rm.session_id,
          type: rm.type,
          seq: rm.seq,
          time_created: rm.time_created,
          time_updated: rm.time_updated,
          data: parsedData,
        };

        let list = sessionMsgMap.get(rm.session_id);
        if (!list) {
          list = [];
          sessionMsgMap.set(rm.session_id, list);
        }
        list.push(msgRecord);
      }

      for (const [sessId, msgs] of sessionMsgMap) {
        const session = sessionMap.get(sessId);
        if (!session) continue;
        for (let j = 0; j < msgs.length; j++) {
          const current = msgs[j]!;
          const preceding = j > 0 ? msgs[j - 1]! : null;
          const classified = classifyPromptProvenance(current, session, preceding);
          disambiguatedMessages.push(classified);
        }
      }
    }

    const provenanceStats = summarizeProvenance(disambiguatedMessages);
    const results: Partial<Record<DetectorName, DetectorRunResult>> = {};

    // 3. Pre-fetch relevant parts in ONE unified scan if needed
    const needsPartScan =
      detector === "all" || detector === "error-recovery" || detector === "harness-health";
    const cachedParts = needsPartScan ? fetchRelevantParts(db, sessionIds) : undefined;

    // 4. Run selected detectors
    if (detector === "all" || detector === "error-recovery") {
      results["error-recovery"] = runErrorRecoveryDetector(db, sessionIds, cachedParts);
    }

    if (detector === "all" || detector === "prompt-compressor") {
      results["prompt-compressor"] = await runPromptCompressorDetector(
        disambiguatedMessages,
        policiesPath
      );
    }

    if (detector === "all" || detector === "harness-health") {
      results["harness-health"] = runHarnessHealthDetector(db, sessionMap, cachedParts);
    }

    if (detector === "all" || detector === "verification-gap") {
      results["verification-gap"] = runVerificationGapDetector(
        db,
        sessions,
        disambiguatedMessages
      );
    }

    const overallEnd = performance.now();

    return {
      timestamp: Date.now(),
      dbPath,
      policiesPath,
      sessionCount: sessions.length,
      executionTimeMs: Math.round(overallEnd - overallStart),
      provenanceStats,
      results,
    };
  } finally {
    db.close();
  }
}

function printHumanReport(report: AnalysisReport): void {
  console.log(`\n\x1b[1;36m======================================================================\x1b[0m`);
  console.log(`\x1b[1;36m  LEVER COACH ANALYSIS REPORT — Non-Destructive Review Proposals\x1b[0m`);
  console.log(`\x1b[1;36m======================================================================\x1b[0m`);
  console.log(`Database:    ${report.dbPath} (readonly)`);
  console.log(`Sessions:    ${report.sessionCount} sessions analyzed in ${report.executionTimeMs}ms\n`);

  console.log(`\x1b[1mPROMPT PROVENANCE DISAMBIGUATION:\x1b[0m`);
  console.log(`  Total Messages Analyzed:  ${report.provenanceStats.totalAnalyzed}`);
  console.log(
    `  Organic Human Prompts:    \x1b[32m${report.provenanceStats.organicCount}\x1b[0m (${report.provenanceStats.organicPercentage}%)`
  );
  console.log(
    `  Injected/Synthetic Turns: \x1b[33m${report.provenanceStats.syntheticCount}\x1b[0m (${report.provenanceStats.syntheticPercentage}%)\n`
  );

  console.log(`  Category Breakdown:`);
  for (const [cat, count] of Object.entries(report.provenanceStats.byCategory)) {
    if (count > 0) {
      const isOrg = cat.startsWith("organic_human_");
      const color = isOrg ? "\x1b[32m" : "\x1b[90m";
      console.log(`    ${color}${cat.padEnd(42)}\x1b[0m ${count}`);
    }
  }

  // Iterate over detector results
  for (const [name, res] of Object.entries(report.results)) {
    if (!res) continue;
    console.log(`\n\x1b[1;35m----------------------------------------------------------------------\x1b[0m`);
    console.log(`\x1b[1;35m  DETECTOR: ${name.toUpperCase()} (${res.executionTimeMs}ms)\x1b[0m`);
    console.log(`\x1b[1;35m----------------------------------------------------------------------\x1b[0m`);
    console.log(`Summary: ${res.summary}`);
    console.log(`Reviewable Proposals: ${res.proposals.length}\n`);

    if (res.proposals.length === 0) {
      console.log(`  (No actionable friction patterns detected in current time range)`);
    } else {
      for (const p of res.proposals) {
        const sevColor =
          p.severity === "high"
            ? "\x1b[31m"
            : p.severity === "medium"
            ? "\x1b[33m"
            : "\x1b[36m";
        console.log(`  \x1b[1m[${p.id}]\x1b[0m ${sevColor}(${p.severity.toUpperCase()})\x1b[0m \x1b[1m${p.title}\x1b[0m`);
        console.log(`    \x1b[90mFrequency:\x1b[0m ${p.frequency} occurrences`);
        console.log(`    \x1b[90mSummary:\x1b[0m   ${p.summary}`);
        console.log(`    \x1b[90mRationale:\x1b[0m ${p.rationale}`);
        console.log(`    \x1b[1;32mProposed Lever:\x1b[0m ${p.proposedAction}`);
        console.log(`    \x1b[90mStatus:\x1b[0m    ${p.status} (requires human review, never auto-applied)\n`);
      }
    }
  }

  console.log(`\x1b[1;36m======================================================================\x1b[0m`);
  console.log(`\x1b[1mExecution completed in ${report.executionTimeMs}ms. All proposals are review-only.\x1b[0m\n`);
}

// CLI entrypoint
const args = process.argv.slice(2);
const options = parseCliArgs(args);

if (options.help) {
  printHelp();
  process.exit(0);
}

try {
  const report = await runAnalysis(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
} catch (err) {
  console.error("lever-coach error:", err);
  process.exit(1);
}
