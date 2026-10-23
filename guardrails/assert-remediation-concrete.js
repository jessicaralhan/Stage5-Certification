// External promptfoo javascript assertion file (loaded via file://, which
// runs as a real Node module — unlike promptfoo's inline `value:` string
// assertions, which run in a restricted eval sandbox with no `require`).
// Replaces the two flaky `llm-rubric` checks documented in iteration.log
// ("specific-not-vague", "concrete-cidr-fix") with the deterministic
// concreteness check in concreteness-check.js.

const { isConcreteFix } = require('./concreteness-check.js');

module.exports = function (output) {
  let parsed;
  try {
    parsed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
  } catch (e) {
    return { pass: false, score: 0, reason: `Could not parse agent output as JSON: ${e.message}` };
  }

  const remediation = parsed.remediations && parsed.remediations[0];
  if (!remediation || !remediation.proposed_fix) {
    return { pass: false, score: 0, reason: 'No remediation with a proposed_fix found in output' };
  }

  const concrete = isConcreteFix(remediation.proposed_fix);
  const preview = remediation.proposed_fix.slice(0, 150);

  return {
    pass: concrete,
    score: concrete ? 1 : 0,
    reason: concrete
      ? `proposed_fix contains an objective concreteness marker (Terraform syntax, AWS API/CLI reference, CIDR, or structured steps): "${preview}..."`
      : `proposed_fix lacks any objective concreteness marker (no Terraform syntax, AWS API/CLI reference, CIDR, or structured steps) - reads as generic guidance: "${preview}..."`,
  };
};
