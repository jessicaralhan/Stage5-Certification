// Deterministic schema validation at the delegation boundary.
//
// Every sub-agent output passes through one of these validators BEFORE the
// coordinator sees it. A failure becomes a structured error the coordinator can
// reason over (retry, proceed, escalate), never malformed data. The LLM decides
// what to do; this code makes sure the inputs to that decision are well-formed.

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const VERDICTS = ['APPROVE', 'REVISE', 'ESCALATE'];

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Placeholder text a concrete fix must not contain. Deliberately does NOT flag
// ordinary brackets or angle brackets (HCL lists, YAML flow sequences and JSON
// arrays are legitimate content in a real fix).
const PLACEHOLDER_RE = /\[\s*(?:TODO|TBD)\s*\]|\b(?:TODO|TBD|FIXME)\b|REPLACE[_-]?ME|CHANGE[_-]?ME|<\s*(?:your|insert|enter)[^>]*>/i;

function maxSeverity(severities) {
  return severities.length ? severities.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : 'LOW';
}

function result(errors) {
  return { valid: errors.length === 0, errors };
}

function requireFields(obj, fields, label, errors) {
  for (const f of fields) if (!isStr(obj[f])) errors.push(`${label}.${f} must be a non-empty string`);
}

// ------------------------------------------------------------------ analyses

function validateTerraformAnalysis(d) {
  const errors = [];
  if (!isObj(d)) return result(['output is not a JSON object']);
  if (!Array.isArray(d.destructive_changes)) errors.push('destructive_changes must be an array');
  if (!Array.isArray(d.security_exposure)) errors.push('security_exposure must be an array');
  if (!Array.isArray(d.cost_notes)) errors.push('cost_notes must be an array');
  if (!SEVERITIES.includes(d.risk_level)) errors.push(`risk_level must be one of ${SEVERITIES.join('|')}`);
  if (errors.length) return result(errors);
  d.destructive_changes.forEach((c, i) => {
    if (!isObj(c)) return errors.push(`destructive_changes[${i}] must be an object`);
    requireFields(c, ['resource', 'action', 'forcing_attribute', 'environment'], `destructive_changes[${i}]`, errors);
    if (!['destroy', 'destroy_and_recreate'].includes(c.action)) errors.push(`destructive_changes[${i}].action must be destroy|destroy_and_recreate`);
    if (!['production', 'non-production'].includes(c.environment)) errors.push(`destructive_changes[${i}].environment must be production|non-production`);
    if (!SEVERITIES.includes(c.severity)) errors.push(`destructive_changes[${i}].severity invalid`);
  });
  d.security_exposure.forEach((s, i) => {
    if (!isObj(s)) return errors.push(`security_exposure[${i}] must be an object`);
    requireFields(s, ['resource', 'issue'], `security_exposure[${i}]`, errors);
    if (!SEVERITIES.includes(s.severity)) errors.push(`security_exposure[${i}].severity invalid`);
  });
  if (!errors.length) {
    const expected = maxSeverity([...d.destructive_changes, ...d.security_exposure].map((f) => f.severity));
    if (d.risk_level !== expected) errors.push(`risk_level ${d.risk_level} is not the highest finding severity (${expected})`);
  }
  return result(errors);
}

function validateKubernetesAnalysis(d) {
  const errors = [];
  if (!isObj(d)) return result(['output is not a JSON object']);
  if (!Array.isArray(d.security_issues)) errors.push('security_issues must be an array');
  if (!isStr(d.summary)) errors.push('summary must be a non-empty string');
  if (!SEVERITIES.includes(d.risk_level)) errors.push(`risk_level must be one of ${SEVERITIES.join('|')}`);
  if (errors.length) return result(errors);
  const types = ['rbac', 'network_policy', 'security_context', 'resource_limits', 'pod_security'];
  d.security_issues.forEach((s, i) => {
    if (!isObj(s)) return errors.push(`security_issues[${i}] must be an object`);
    requireFields(s, ['resource_kind', 'resource_name', 'namespace', 'description'], `security_issues[${i}]`, errors);
    if (!types.includes(s.type)) errors.push(`security_issues[${i}].type must be one of ${types.join('|')}`);
    if (!SEVERITIES.includes(s.severity)) errors.push(`security_issues[${i}].severity invalid`);
  });
  if (!errors.length) {
    const expected = maxSeverity(d.security_issues.map((f) => f.severity));
    if (d.risk_level !== expected) errors.push(`risk_level ${d.risk_level} is not the highest finding severity (${expected})`);
  }
  return result(errors);
}

function validateIamAnalysis(d) {
  const errors = [];
  if (!isObj(d)) return result(['output is not a JSON object']);
  if (!Array.isArray(d.access_issues)) errors.push('access_issues must be an array');
  if (!isStr(d.summary)) errors.push('summary must be a non-empty string');
  if (!SEVERITIES.includes(d.risk_level)) errors.push(`risk_level must be one of ${SEVERITIES.join('|')}`);
  if (errors.length) return result(errors);
  const types = ['overly_broad_permissions', 'missing_resource_boundaries', 'unused_role', 'missing_mfa', 'session_ttl', 'missing_conditions'];
  d.access_issues.forEach((s, i) => {
    if (!isObj(s)) return errors.push(`access_issues[${i}] must be an object`);
    requireFields(s, ['description'], `access_issues[${i}]`, errors);
    if (!types.includes(s.type)) errors.push(`access_issues[${i}].type must be one of ${types.join('|')}`);
    if (!SEVERITIES.includes(s.severity)) errors.push(`access_issues[${i}].severity invalid`);
    if (!Array.isArray(s.affected_principals)) errors.push(`access_issues[${i}].affected_principals must be an array`);
    if (!Array.isArray(s.affected_resources)) errors.push(`access_issues[${i}].affected_resources must be an array`);
  });
  if (!errors.length) {
    const expected = maxSeverity(d.access_issues.map((f) => f.severity));
    if (d.risk_level !== expected) errors.push(`risk_level ${d.risk_level} is not the highest finding severity (${expected})`);
  }
  return result(errors);
}

// -------------------------------------------------------------- remediations

function checkRemediationList(list, label, concreteField, fixTypes, extraRequired, expectedCount, errors) {
  if (!Array.isArray(list)) return errors.push(`${label} must be an array`);
  if (list.length !== expectedCount) {
    errors.push(`expected exactly one ${label.slice(0, -1) || 'entry'} per finding (${expectedCount}), got ${list.length}`);
  }
  list.forEach((r, i) => {
    if (!isObj(r)) return errors.push(`${label}[${i}] must be an object`);
    requireFields(r, [...extraRequired, concreteField], `${label}[${i}]`, errors);
    if (!fixTypes.includes(r.fix_type)) errors.push(`${label}[${i}].fix_type must be one of ${fixTypes.join('|')}`);
    if (!SEVERITIES.includes(r.severity)) errors.push(`${label}[${i}].severity invalid`);
    if (isStr(r[concreteField])) {
      if (PLACEHOLDER_RE.test(r[concreteField])) errors.push(`${label}[${i}].${concreteField} contains placeholder text`);
      if (r[concreteField].trim().length < 10) errors.push(`${label}[${i}].${concreteField} is too short to be a concrete fix`);
    }
  });
}

function validateTerraformRemediation(d, analysis) {
  const errors = [];
  if (!isObj(d)) return result(['output is not a JSON object']);
  const count = analysis ? analysis.destructive_changes.length + analysis.security_exposure.length : (d.remediations || []).length;
  checkRemediationList(d.remediations, 'remediations', 'proposed_fix', ['lifecycle_change', 'config_change', 'process_change'], ['resource', 'issue'], count, errors);
  if (!errors.length && analysis) {
    const known = new Set([...analysis.destructive_changes, ...analysis.security_exposure].map((f) => f.resource));
    d.remediations.forEach((r, i) => { if (!known.has(r.resource)) errors.push(`remediations[${i}].resource "${r.resource}" is not one of the analyzed findings (no invented findings)`); });
  }
  return result(errors);
}

function validateKubernetesRemediation(d, analysis) {
  const errors = [];
  if (!isObj(d)) return result(['output is not a JSON object']);
  const count = analysis ? analysis.security_issues.length : (d.fixes || []).length;
  checkRemediationList(d.fixes, 'fixes', 'concrete_yaml', ['rbac', 'network_policy', 'security_context', 'resource_limits', 'pod_security'], ['resource'], count, errors);
  if (!errors.length) d.fixes.forEach((r, i) => { if (!/apiVersion|securityContext|resources:|verbs|hostNetwork|runAs|limits|ingress|egress|podSelector/i.test(r.concrete_yaml)) errors.push(`fixes[${i}].concrete_yaml has no recognizable Kubernetes configuration`); });
  if (!errors.length && analysis) {
    const known = new Set(analysis.security_issues.map((f) => f.resource_name));
    d.fixes.forEach((r, i) => { if (!known.has(r.resource)) errors.push(`fixes[${i}].resource "${r.resource}" is not one of the analyzed findings (no invented findings)`); });
  }
  return result(errors);
}

function validateIamRemediation(d, analysis) {
  const errors = [];
  if (!isObj(d)) return result(['output is not a JSON object']);
  const count = analysis ? analysis.access_issues.length : (d.fixes || []).length;
  checkRemediationList(d.fixes, 'fixes', 'concrete_policy_change', ['permission_narrowing', 'resource_scoping', 'mfa_requirement'], ['issue'], count, errors);
  return result(errors);
}

// ------------------------------------------------------------------- reviews

// The adversarial reviewer's output: a verdict plus well-formed challenges.
function validateReview(d) {
  const errors = [];
  if (!isObj(d)) return result(['output is not a JSON object']);
  if (!VERDICTS.includes(d.verdict)) errors.push(`verdict must be one of ${VERDICTS.join('|')}`);
  if (!isStr(d.reasoning)) errors.push('reasoning must be a non-empty string');
  if (!Array.isArray(d.challenges)) errors.push('challenges must be an array');
  if (!Array.isArray(d.verified_claims)) errors.push('verified_claims must be an array');
  if (errors.length) return result(errors);

  const ids = new Set();
  d.challenges.forEach((c, i) => {
    if (!isObj(c)) return errors.push(`challenges[${i}] must be an object`);
    requireFields(c, ['id', 'target', 'claim', 'evidence'], `challenges[${i}]`, errors);
    if (!SEVERITIES.includes(c.severity)) errors.push(`challenges[${i}].severity invalid`);
    if (!['analysis', 'remediation'].includes(c.artifact)) errors.push(`challenges[${i}].artifact must be analysis|remediation`);
    if (!['file', 'reasoning'].includes(c.evidence_source)) errors.push(`challenges[${i}].evidence_source must be file|reasoning`);
    if (typeof c.requires_human_signoff !== 'boolean') errors.push(`challenges[${i}].requires_human_signoff must be a boolean`);
    if (isStr(c.id)) { if (ids.has(c.id)) errors.push(`challenges[${i}].id "${c.id}" is duplicated`); ids.add(c.id); }
  });
  d.verified_claims.forEach((v, i) => {
    if (!isStr(v)) errors.push(`verified_claims[${i}] must be a non-empty string`);
  });
  if (!errors.length) {
    if (d.verdict !== 'APPROVE' && d.challenges.length === 0) errors.push(`verdict ${d.verdict} requires at least one challenge`);
    const blocking = d.challenges.some((c) => RANK[c.severity] >= RANK.HIGH || c.requires_human_signoff);
    if (d.verdict === 'APPROVE' && blocking) errors.push('verdict APPROVE is inconsistent with a HIGH/CRITICAL challenge or a challenge requiring human sign-off');
    if (d.verdict === 'REVISE' && d.challenges.some((c) => c.requires_human_signoff)) errors.push('verdict REVISE is inconsistent with a challenge requiring human sign-off (that is ESCALATE)');
  }
  return result(errors);
}

// -------------------------------------------------------- final review writer

const HEADING_LINE_RE = /^\s{0,3}#{1,6}\s+/;
const BACKTICK_RE = /`([^`\n]{2,120})`/g;

// Headings never come from the LLM. Any heading line it writes is demoted to
// bold text so the report structure stays harness-controlled.
function sanitizeProse(text) {
  return String(text)
    .split('\n')
    .map((line) => (HEADING_LINE_RE.test(line) ? `**${line.replace(HEADING_LINE_RE, '').trim()}**` : line))
    .join('\n')
    .trim();
}

function validateFinalReview(d, { workflows, sourceText }) {
  const errors = [];
  if (!isObj(d)) return result(['output is not a JSON object']);
  if (!isStr(d.executive_summary)) errors.push('executive_summary must be non-empty markdown');
  if (!isObj(d.sections)) errors.push('sections must be an object keyed by workflow');
  if (errors.length) return result(errors);
  for (const w of workflows) if (!isStr(d.sections[w])) errors.push(`sections.${w} must be non-empty markdown`);
  for (const k of Object.keys(d.sections)) if (!workflows.includes(k)) errors.push(`sections.${k} is not an executed workflow`);

  // "Does not add new findings": every identifier the prose puts in backticks,
  // and every severity word it uses, must already exist in the moderated context.
  if (!errors.length && sourceText) {
    const prose = [d.executive_summary, ...Object.values(d.sections)].join('\n');
    const unknown = new Set();
    for (const m of prose.matchAll(BACKTICK_RE)) if (!sourceText.includes(m[1])) unknown.add(m[1]);
    if (unknown.size) errors.push(`prose introduces identifiers not present in the findings: ${[...unknown].slice(0, 5).join(', ')}`);
    const present = new Set(SEVERITIES.filter((s) => sourceText.includes(s)));
    const used = new Set((prose.match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/g) || []));
    const extra = [...used].filter((s) => !present.has(s));
    if (extra.length) errors.push(`prose uses severity levels not present in the findings: ${extra.join(', ')}`);
  }
  return result(errors);
}

// --------------------------------------------------------------- disposition

function validateDisposition(d) {
  const errors = [];
  if (!isObj(d)) return result(['disposition is not a JSON object']);
  if (!['APPROVE', 'ESCALATE'].includes(d.disposition)) errors.push('disposition must be APPROVE or ESCALATE');
  if (!isStr(d.rationale)) errors.push('rationale must be a non-empty string');
  if (!Array.isArray(d.workflows_reviewed) || d.workflows_reviewed.length === 0) errors.push('workflows_reviewed must be a non-empty array');
  if (!Array.isArray(d.unresolved_challenges)) errors.push('unresolved_challenges must be an array');
  return result(errors);
}

module.exports = {
  SEVERITIES, RANK, VERDICTS, PLACEHOLDER_RE,
  maxSeverity, sanitizeProse,
  validateTerraformAnalysis, validateKubernetesAnalysis, validateIamAnalysis,
  validateTerraformRemediation, validateKubernetesRemediation, validateIamRemediation,
  validateReview, validateFinalReview, validateDisposition,
};
