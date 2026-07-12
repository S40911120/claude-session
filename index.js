'use strict';
/**
 * recensa-session — Claude Code session JSONL toolkit (library entry / require('@recensa/claude-session'))
 *
 * Design: strongly-typed named functions rather than a generic run(cmd, file) dispatch.
 * Each intel function returns a structured object identical in shape to the CLI `<cmd> --json`
 * output; the equivalence is mechanically proven by test/parity.test.js.
 * For the CLI entry see bin/recensa-session.js (package "bin"); this file is package "main", called
 * in-process by the recensa adapter via a worker thread.
 *
 * Name mapping (the 9 commands the adapter relies on + surgery):
 *   overview tasks goal guard failures tokenBudget deadContext cacheGuard reconstruct   ← intel
 *   verify repair                                                                        ← surgery
 */

// ── intel: analysis (returns structured objects, same shape as CLI --json) ──────────────────────

/**
 * One-page combined report (goal + tasks + tools + files + tokens + cache warnings + chronicle + fork lineage).
 * @param {string} file  absolute path to the session .jsonl
 * @param {{recentPromptCount?:number, sinceMs?:number, untilMs?:number}} [opts]
 * @returns {Promise<object>} overview object (= overview --json)
 */
function overview(file, opts = {}) {
  return require('./intel/session-overview').buildOverview(file, opts);
}

/**
 * Task list (filtered array; no filtering by default).
 * @param {string} file
 * @returns {Promise<object[]>} filterTasks result (= tasks --json)
 */
async function tasks(file) {
  const { extractTasks, filterTasks } = require('./intel/session-tasks');
  return filterTasks(await extractTasks(file, {}), {});
}

/**
 * Current goal + historical events.
 * @param {string} file
 * @returns {Promise<{current:(object|null), events:object[]}>} (= goal --json)
 */
async function goal(file) {
  const { extractGoals, getCurrentGoal } = require('./intel/session-goal');
  const events = await extractGoals(file);
  return { current: getCurrentGoal(events), events };
}

/**
 * Session degradation signals (PURITY / CHURN / SATURATION axes).
 * @param {string} file
 * @param {{top?:number}} [opts]  max number of files listed in the churn table (default 10, matches CLI --top)
 * @returns {Promise<object>} (= guard --json)
 */
async function guard(file, { top = 10 } = {}) {
  const { scan, judge } = require('./intel/session-guard');
  const stats = await scan(file);
  const verdict = judge(stats, { churnWarn: 5, churnSevere: 10, top });
  return {
    sessionPath: stats.sessionPath,
    overall: verdict.overall,
    purity: verdict.purity,
    churn: { ...verdict.churn, files: verdict.churn.files.slice(0, top) },
    saturation: verdict.saturation,
  };
}

/**
 * Full tool-failure survey + thrash detection.
 * @param {string} file
 * @returns {Promise<{total:number, thrashRuns:object[], failures:object[]}>} (= failures --json)
 */
async function failures(file) {
  const { scanFailures, detectThrash } = require('./intel/session-failures');
  const list = await scanFailures(file);
  return { total: list.length, thrashRuns: detectThrash(list), failures: list };
}

/**
 * Full token-budget report.
 * @param {string} file
 * @param {{contextWindow?:number}} [opts]
 * @returns {Promise<object>} (= token-budget default json)
 */
async function tokenBudget(file, { contextWindow } = {}) {
  const tb = require('./intel/token-budget');
  const result = await tb.analyzeBudget(file, { contextWindow });
  return {
    sessionPath: result.sessionPath,
    fixedCosts: result.fixedCosts,
    apiReported: result.apiReported,
    estimated: result.estimated,
    budgetUsage: result.budgetUsage,
    thresholds: {
      effectiveWindow: tb.effectiveWindow(),
      autoCompact: tb.autoCompactThreshold(),
      warning: tb.warningThreshold(),
      blocking: tb.blockingLimit(),
    },
    turnCount: result.turns.length,
    waste: result.waste.length > 0 ? result.waste : undefined,
  };
}

/**
 * Dead-context detection.
 * @param {string} file
 * @param {string} [strategy]  if omitted, detectDeadContext's built-in default is used
 * @returns {Promise<object>} (= dead-context --json)
 */
async function deadContext(file, strategy) {
  const { detectDeadContext } = require('./intel/dead-context');
  return detectDeadContext(file, strategy);
}

/**
 * Prompt-cache killer detection.
 * @param {string} file
 * @returns {Promise<object>} (= cache-guard --json)
 */
async function cacheGuard(file) {
  const { scanSession } = require('./intel/cache-guard');
  return scanSession(file);
}

/**
 * Follow the forkedFrom chain to restore the full pre-compaction conversation → write a clean jsonl to outPath (side-effect).
 * @param {string} file     source session .jsonl
 * @param {string} outPath  output path for the clean jsonl
 * @param {object} [opts]
 * @returns {Promise<object>} reconstruct statistics
 */
function reconstruct(file, outPath, opts = {}) {
  return require('./intel/session-reconstruct').reconstruct(file, { out: outPath, ...opts });
}

// ── surgery: structural surgery (returns structured results) ──────────────────────────────────

/** Session resume validity check (24 checks). @returns {Promise<object>} verify report */
function verify(file, opts = {}) {
  return require('./surgery/session-verify').verify(file, opts);
}

/** Automatic repair (orphans / ordering / duplicates / broken thinking, etc.). @returns {Promise<object>} repair result */
function repair(file, opts = {}) {
  return require('./surgery/session-repair').repairAll(file, opts);
}

// ── Low-level: streaming parse engine (for in-process downstream use by token-meter, etc.) ─────────────────
/** @returns {typeof import('./intel/session-parser').SessionParser} */
function getSessionParser() {
  return require('./intel/session-parser').SessionParser;
}

// ── config: session JSONL root directory (public re-export so downstream doesn't deep-import lib/) ──
/**
 * Resolve the Claude Code session JSONL root directory
 * (RECENSA_PROJECTS_DIR -> CLAUDE_CONFIG_DIR/projects -> ~/.claude/projects).
 * @param {{validate?:boolean}} [opts] validate=true -> existsSync check, throw if missing
 * @returns {string} absolute root directory
 */
function resolveProjectsDir(opts) {
  return require('./lib/resolver').resolveProjectsDir(opts);
}

module.exports = {
  // intel
  overview, tasks, goal, guard, failures, tokenBudget, deadContext, cacheGuard, reconstruct,
  // surgery
  verify, repair,
  // low-level
  getSessionParser,
  // config
  resolveProjectsDir,
};
