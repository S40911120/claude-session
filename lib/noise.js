'use strict';
/* Single source of truth for noise detection: which user-role messages are not real human-typed dialogue.
   Shared by every human-text / clean-dialogue consumer so the classification is not duplicated and cannot
   drift. */

// Non-human user text (compaction summaries / local-command caveat output / system-reminder / scheduled tasks / interrupts / harness continuation prompts)
const NON_HUMAN = /^(This session is being continued from a previous conversation|Caveat:|<command-|<local-command|<system-reminder|<scheduled-task|Please continue|Continue from where you left off|\[Request interrupted)/i;

// emptyKind is classified by SessionParser: tool_result / system_reminder / task_notification / hook_feedback / empty_input
function isNoiseUserMessage(m) {
  if (m?.role !== 'user') return false;
  if (m.emptyKind) return true;                              // empty-shell user (pure tool_result / reminder / notification…)
  if (m.text && NON_HUMAN.test(m.text.trim())) return true;  // compaction summary / caveat / command output and other non-human text
  return false;
}

// ── Optional block folding (opt-in via a --collapse-blocks caller) ─────────────────────────
// Replaces large non-typed blocks embedded in human messages with placeholders while keeping the
// human wording; off by default (omit the flag to keep the full original text).
// The ruleset is the single source of truth and is extensible: each entry is { re, key }, where key selects the actual
// placeholder text from PLACEHOLDERS below. Targets tool calls / slash-command markers /
// system-reminder / pasted skill·command frontmatter. Long code fences are handled separately by
// collapseBlocks via a line-count threshold.
const COLLAPSE_RULES = [
  { re: /<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, key: 'slashCommand' },
  { re: /<local-command-(stdout|stderr)>[\s\S]*?<\/local-command-\1>/g, key: 'commandOutput' },
  { re: /<system-reminder>[\s\S]*?<\/system-reminder>/g, key: 'systemReminder' },
  { re: /<function_(calls|results)>[\s\S]*?<\/function_\1>/g, key: 'toolCall' },
  { re: /<(tool_use|tool_result)\b[\s\S]*?<\/\1>/g, key: 'toolCall' },
  // Pasted skill/command/agent frontmatter: co-occurring name: + description: is a strong signal, rare in human markdown
  { re: /^---\r?\n(?=[\s\S]*?\bname:)(?=[\s\S]*?\bdescription:)[\s\S]*?\r?\n---/gm, key: 'frontmatter' },
];

// English placeholder set for folded non-typed blocks (the only set this public library ships).
// A caller that needs a different set (e.g. the maintainer's internal extraction tool, which keeps a
// byte-stable output contract) passes its own object via the `placeholders` option below.
const PLACEHOLDERS = {
  slashCommand: '[slash-command marker]',
  commandOutput: '[command output]',
  systemReminder: '[system-reminder]',
  toolCall: '[tool-call block]',
  frontmatter: '[skill/command frontmatter block]',
  codeFence: (lines, suffix) => `[code block omitted: ${lines} lines${suffix}]`,
};

// Fold non-typed blocks inside a message. minFenceLines: a code fence is replaced with a placeholder only
// when it spans ≥ this many lines (short snippets are kept). placeholders overrides the default English set
// (used by an external caller that must keep its own extraction output byte-identical).
function collapseBlocks(text, { minFenceLines = 8, placeholders } = {}) {
  if (!text) return text;
  const ph = placeholders || PLACEHOLDERS;
  let t = text;
  for (const { re, key } of COLLAPSE_RULES) t = t.replace(re, ph[key]);
  t = t.replace(/```([^\n]*)\n([\s\S]*?)```/g, (m, fenceLang, body) => {
    const lines = body.split('\n').length;
    if (lines < minFenceLines) return m;
    const label = fenceLang.trim();
    const suffix = label ? ` (${label})` : '';
    return ph.codeFence(lines, suffix);
  });
  return t;
}

module.exports = { NON_HUMAN, isNoiseUserMessage, COLLAPSE_RULES, PLACEHOLDERS, collapseBlocks };
