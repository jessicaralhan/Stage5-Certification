// Deterministic (non-AI) guardrail: validates that each agent's JSON output
// matches the schema its downstream agent expects, before it is allowed to
// pass through the handoff. Runs as plain code — no model call, no judgment.

function validateAgent1Output(json) {
  const errors = [];
  const requiredArrays = ["destructive_changes", "security_exposure"];
  const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

  for (const key of requiredArrays) {
    if (!Array.isArray(json[key])) errors.push(`missing or non-array field: ${key}`);
  }
  if (!validSeverities.includes(json.risk_level)) {
    errors.push(`invalid risk_level: ${json.risk_level}`);
  }
  // A guardrail that throws on malformed input instead of reporting it as
  // invalid defeats its own purpose — guard every array walk with
  // Array.isArray() rather than the `|| []` fallback, which only catches
  // undefined/null and still crashes on any other truthy non-array value
  // (e.g. a hallucinated string field). Found by guardrail-bypass-test.js.
  if (Array.isArray(json.destructive_changes)) {
    json.destructive_changes.forEach((c, i) => {
      if (!c.resource) errors.push(`destructive_changes[${i}] missing resource`);
      if (!validSeverities.includes(c.severity)) errors.push(`destructive_changes[${i}] invalid severity`);
    });
  }
  if (Array.isArray(json.security_exposure)) {
    json.security_exposure.forEach((c, i) => {
      if (!c.resource) errors.push(`security_exposure[${i}] missing resource`);
      if (!validSeverities.includes(c.severity)) errors.push(`security_exposure[${i}] invalid severity`);
    });
  }

  return { valid: errors.length === 0, errors };
}

function validateAgent2Output(json) {
  const errors = [];
  if (!Array.isArray(json.remediations)) {
    errors.push("missing or non-array field: remediations");
    return { valid: false, errors };
  }
  json.remediations.forEach((r, i) => {
    if (!r.resource) errors.push(`remediations[${i}] missing resource`);
    if (!r.proposed_fix || r.proposed_fix.trim().length < 10) {
      errors.push(`remediations[${i}] proposed_fix missing or too vague`);
    }
    if (/\[TODO\]|\[TBD\]/i.test(r.proposed_fix || "")) {
      errors.push(`remediations[${i}] contains placeholder text`);
    }
  });
  return { valid: errors.length === 0, errors };
}

function validateAgent3Output(json) {
  const errors = [];
  const validVerdicts = ["APPROVE", "REVISE", "ESCALATE"];
  if (!Array.isArray(json.reviewed_remediations)) {
    errors.push("missing or non-array field: reviewed_remediations");
  }
  if (!validVerdicts.includes(json.verdict)) {
    errors.push(`invalid verdict: ${json.verdict}`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validateAgent1Output, validateAgent2Output, validateAgent3Output };
