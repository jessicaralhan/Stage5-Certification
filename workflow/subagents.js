// Sub-agent runners. Each function here is what a coordinator `launch_*` tool
// dispatches to. Every run:
//   1. checks deterministic preconditions (budget, input type, order of steps),
//   2. makes its own model call(s) with its own scoped tools,
//   3. validates the output against workflow/schemas.js,
//   4. returns either { ok: true, ... } or a structured { ok: false, error }.
// The coordinator never receives malformed data; it receives a validated result
// or a structured error it can reason over.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fillTemplate, parseModelJson } = require('./json-utils');
const S = require('./schemas');

const READ_FILE_TOOL = {
  name: 'read_file',
  description: 'Read the source file under examination. Read-only. Takes no path argument beyond the file name given in the assignment; any other path is refused.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'The source file name from the assignment' } },
    required: ['path'],
  },
};

const REVIEWER_MAX_TURNS = 6;
const WORKFLOW_ORDER = ['terraform', 'kubernetes', 'iam'];

// Per-workflow wiring. Everything workflow-specific lives here, so the rest of
// the harness is workflow-agnostic and each workflow's scope stays explicit.
const WORKFLOWS = {
  terraform: {
    agentId: 'terraform_workflow',
    contentVar: 'plan_output',
    findingsCount: (a) => a.destructive_changes.length + a.security_exposure.length,
    validateAnalysis: S.validateTerraformAnalysis,
    validateRemediation: S.validateTerraformRemediation,
    accepts: (content) => /Terraform (will perform|used the selected providers)|^\s*#\s+\S+\s+(will be|must be)\s|resource\s+"[^"]+"\s+"[^"]+"|\b(aws|azurerm|google)_[a-z0-9_]+\.[a-z0-9_-]+/im.test(content),
  },
  kubernetes: {
    agentId: 'kubernetes_workflow',
    contentVar: 'manifests',
    findingsCount: (a) => a.security_issues.length,
    validateAnalysis: S.validateKubernetesAnalysis,
    validateRemediation: S.validateKubernetesRemediation,
    accepts: (content) => /^\s*apiVersion:\s*\S+/m.test(content) && /^\s*kind:\s*\S+/m.test(content),
  },
  iam: {
    agentId: 'iam_workflow',
    contentVar: 'policy',
    findingsCount: (a) => a.access_issues.length,
    validateAnalysis: S.validateIamAnalysis,
    validateRemediation: S.validateIamRemediation,
    accepts: (content) => {
      try {
        const parsed = JSON.parse(content);
        return parsed !== null && typeof parsed === 'object' && /"Statement"|"bindings"|"permissions"|"actions"/.test(content);
      } catch (e) {
        return false;
      }
    },
  },
};

const err = (code, message, extra = {}) => ({ ok: false, error: { code, message, retryable: false, ...extra } });
const sha = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);

function loadPrompt(ctx, relPath) {
  return fs.readFileSync(path.join(ctx.rootDir, relPath), 'utf8');
}

function subAgent(ctx, id) {
  const a = ctx.manifest.sub_agents.find((s) => s.id === id);
  if (!a) throw new Error(`manifest has no sub-agent "${id}"`);
  return a;
}

function readInputText(ctx) {
  const buf = fs.readFileSync(ctx.inputFile);
  if (buf.length > 500000) throw new Error(`input file is ${buf.length} bytes, above the 500000 byte limit`);
  return buf.toString('utf8');
}

function cloudPlatform(content) {
  if (/"bindings"/.test(content)) return 'gcp';
  if (/"permissions"|"roleName"/.test(content)) return 'azure';
  return 'aws';
}

function formatChallenges(challenges) {
  if (!Array.isArray(challenges) || challenges.length === 0) return 'None (first pass).';
  return challenges.map((c, i) => `${i + 1}. [${c.artifact || 'artifact'}] target: ${c.target} | claim: ${c.claim}`).join('\n');
}

function wfState(ctx, workflow) {
  return (ctx.state[workflow] = ctx.state[workflow] || { analysis: null, remediation: null, reviews: [] });
}

function newArtifactId(ctx, workflow, kind) {
  ctx.artifactSeq += 1;
  return `A${ctx.artifactSeq}-${workflow}-${kind}`;
}

// Any change to a workflow's artifacts invalidates a final report written earlier.
function invalidateFinalReview(ctx, reason) {
  if (ctx.finalReview) {
    ctx.audit.record('final_review_invalidated', { reason });
    ctx.finalReview = null;
  }
}

// --------------------------------------------------------- workflow sub-agents

async function runWorkflowStep(ctx, workflow, input) {
  const wf = WORKFLOWS[workflow];
  const step = input && input.step;
  if (!wf) return err('UNKNOWN_WORKFLOW', `no workflow "${workflow}"`);
  if (!['analyze', 'remediate'].includes(step)) return err('INVALID_TOOL_INPUT', 'step must be "analyze" or "remediate"');

  const challenges = Array.isArray(input.challenges) ? input.challenges : [];
  const state = wfState(ctx, workflow);
  const agent = subAgent(ctx, wf.agentId);

  if (challenges.length) {
    ctx.revisions[workflow] = (ctx.revisions[workflow] || 0) + 1;
    if (ctx.revisions[workflow] > ctx.manifest.coordinator.limits.max_remediation_revisions_per_workflow) {
      return err('REVISION_CAP_REACHED', `${workflow} has already been re-invoked ${ctx.revisions[workflow] - 1} time(s) with challenges; the cap is ${ctx.manifest.coordinator.limits.max_remediation_revisions_per_workflow}. Escalate instead of revising again.`);
    }
  }

  let content;
  try {
    content = readInputText(ctx);
  } catch (e) {
    return err('INPUT_UNREADABLE', e.message);
  }
  if (!wf.accepts(content)) {
    return err('INPUT_TYPE_MISMATCH', `the input file does not look like a ${workflow} input; no model call was made. Consider a different workflow.`);
  }

  if (step === 'remediate') {
    if (!state.analysis) return err('PRECONDITION_FAILED', `${workflow} has no validated analysis yet; call step=analyze first`);
    if (wf.findingsCount(state.analysis.data) === 0) {
      state.remediation = null;
      return { ok: true, workflow, step, note: 'NOTHING_TO_REMEDIATE: the analysis has no findings', artifact_id: null, result: null };
    }
  }

  const promptFile = agent.prompts[step];
  const vars = { environment: ctx.environment, cloud_platform: cloudPlatform(content), challenges: formatChallenges(challenges) };
  if (step === 'analyze') vars[wf.contentVar] = content;
  else vars.findings = JSON.stringify(state.analysis.data, null, 2);

  const contextId = `${agent.id}-${step}-${crypto.randomUUID().slice(0, 8)}`;
  const resp = await ctx.client.callMessages({
    messages: [{ role: 'user', content: fillTemplate(loadPrompt(ctx, promptFile), vars) }],
    model: ctx.model,
    maxTokens: 4096,
  });
  ctx.audit.recordLlmCall({ agent: agent.id, workflow, step, contextId, resp });

  const parsed = parseModelJson(resp.text, resp.stopReason);
  if (!parsed.ok) {
    ctx.audit.record('validation_failed', { agent: agent.id, workflow, step, code: parsed.error.code, message: parsed.error.message });
    return { ok: false, error: parsed.error };
  }

  const verdict = step === 'analyze'
    ? wf.validateAnalysis(parsed.data)
    : wf.validateRemediation(parsed.data, state.analysis.data);
  if (!verdict.valid) {
    ctx.audit.record('validation_failed', { agent: agent.id, workflow, step, code: 'SCHEMA_VALIDATION_FAILED', details: verdict.errors });
    return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: `${step} output failed schema validation`, retryable: true, details: verdict.errors } };
  }

  const artifactId = newArtifactId(ctx, workflow, step === 'analyze' ? 'analysis' : 'remediation');
  const artifact = { artifact_id: artifactId, data: parsed.data, json_bare: parsed.bare, context_id: contextId, revision_challenges: challenges.length };
  if (step === 'analyze') {
    state.analysis = artifact;
    state.remediation = null; // a new analysis invalidates remediation built on the old one
  } else {
    state.remediation = artifact;
  }
  invalidateFinalReview(ctx, `${workflow} ${step} produced ${artifactId}`);
  ctx.audit.record('artifact_created', { artifact_id: artifactId, agent: agent.id, workflow, step, content_sha: sha(parsed.data), json_bare: parsed.bare, revision_challenges: challenges.length });
  return { ok: true, workflow, step, artifact_id: artifactId, result: parsed.data };
}

// ---------------------------------------------------------- adversarial review

// The only tool the reviewer holds. Jailed to the single declared input file.
function executeReadFile(ctx, toolInput) {
  const spec = ctx.manifest.sub_agents.find((s) => s.id === 'adversarial_reviewer').tools[0];
  const requested = toolInput && typeof toolInput.path === 'string' ? toolInput.path : '';
  const allowed = requested === ctx.inputName || path.resolve(requested) === ctx.inputFile;
  if (!allowed) {
    ctx.audit.record('tool_call', { agent: 'adversarial_reviewer', tool: 'read_file', path: requested, ok: false, error: 'PATH_NOT_ALLOWED' });
    return { ok: false, content: `PATH_NOT_ALLOWED: read_file may only read the declared source file "${ctx.inputName}".` };
  }
  const buf = fs.readFileSync(ctx.inputFile);
  const truncated = buf.length > spec.max_bytes;
  const text = buf.subarray(0, spec.max_bytes).toString('utf8');
  ctx.audit.record('tool_call', { agent: 'adversarial_reviewer', tool: 'read_file', path: requested, ok: true, bytes: Math.min(buf.length, spec.max_bytes), truncated });
  return { ok: true, content: truncated ? `${text}\n[file truncated at ${spec.max_bytes} bytes]` : text, text };
}

const normalizeWs = (s) => String(s).replace(/\s+/g, ' ').trim();

// Deterministic claim verification: a challenge that says its evidence is a
// quote from the file must actually be a substring of the file.
function checkEvidence(review, fileText) {
  const normFile = normalizeWs(fileText);
  const checks = review.challenges.map((c) => {
    if (c.evidence_source !== 'file') return { id: c.id, source: 'reasoning', verified: null };
    return { id: c.id, source: 'file', verified: normFile.includes(normalizeWs(c.evidence)) };
  });
  return {
    file_quotes: checks.filter((c) => c.source === 'file').length,
    verified: checks.filter((c) => c.verified === true).length,
    unverified: checks.filter((c) => c.verified === false).map((c) => c.id),
    detail: checks,
  };
}

async function runAdversarialReviewer(ctx, input) {
  const workflow = input && input.workflow;
  if (!WORKFLOWS[workflow]) return err('INVALID_TOOL_INPUT', 'workflow must be one of terraform, kubernetes, iam');
  const state = wfState(ctx, workflow);
  if (!state.analysis) return err('PRECONDITION_FAILED', `${workflow} has no analysis to review; run the workflow first`);

  const agent = subAgent(ctx, 'adversarial_reviewer');
  const contextId = `rev-${crypto.randomUUID().slice(0, 8)}`;
  const prior = state.reviews.length ? state.reviews[state.reviews.length - 1].data.challenges : [];

  const prompt = fillTemplate(loadPrompt(ctx, agent.prompt), {
    workflow,
    environment: ctx.environment,
    input_name: ctx.inputName,
    analysis: JSON.stringify(state.analysis.data, null, 2),
    remediation: state.remediation ? JSON.stringify(state.remediation.data, null, 2) : 'None (the analysis found nothing to remediate).',
    prior_challenges: prior.length ? JSON.stringify(prior, null, 2) : 'None (first review).',
  });

  // Isolation by construction: a brand-new message list containing only the
  // review assignment. The producing agents' messages and the coordinator's
  // messages never enter this array.
  const messages = [{ role: 'user', content: prompt }];
  ctx.audit.record('reviewer_context_started', { context_id: contextId, workflow, isolated_context: true, initial_message_count: messages.length });

  let fileText = null;
  let fileReads = 0;
  let finalResp = null;
  for (let turn = 1; turn <= REVIEWER_MAX_TURNS; turn++) {
    const resp = await ctx.client.callMessages({ messages, tools: [READ_FILE_TOOL], model: ctx.model, maxTokens: 4096 });
    ctx.audit.recordLlmCall({ agent: agent.id, workflow, step: 'review', contextId, resp, turn });
    messages.push({ role: 'assistant', content: resp.content });
    if (resp.stopReason !== 'tool_use') {
      finalResp = resp;
      break;
    }
    const results = [];
    for (const block of resp.content.filter((b) => b.type === 'tool_use')) {
      if (block.name !== 'read_file') {
        ctx.audit.record('blocked_tool_call', { agent: agent.id, tool: block.name, reason: 'not in the reviewer manifest' });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: `TOOL_NOT_AVAILABLE: ${block.name}`, is_error: true });
        continue;
      }
      const out = executeReadFile(ctx, block.input);
      if (out.ok) { fileReads += 1; fileText = out.text; }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: out.content, is_error: !out.ok });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!finalResp) return { ok: false, error: { code: 'REVIEWER_DID_NOT_FINISH', message: `reviewer used all ${REVIEWER_MAX_TURNS} turns without returning a verdict`, retryable: true } };

  const parsed = parseModelJson(finalResp.text, finalResp.stopReason);
  if (!parsed.ok) {
    ctx.audit.record('validation_failed', { agent: agent.id, workflow, step: 'review', code: parsed.error.code, message: parsed.error.message });
    return { ok: false, error: parsed.error };
  }
  const verdict = S.validateReview(parsed.data);
  if (!verdict.valid) {
    ctx.audit.record('validation_failed', { agent: agent.id, workflow, step: 'review', code: 'SCHEMA_VALIDATION_FAILED', details: verdict.errors });
    return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: 'review output failed schema validation', retryable: true, details: verdict.errors } };
  }
  if (fileReads === 0) {
    ctx.audit.record('validation_failed', { agent: agent.id, workflow, step: 'review', code: 'REVIEWER_DID_NOT_VERIFY' });
    return { ok: false, error: { code: 'REVIEWER_DID_NOT_VERIFY', message: 'the reviewer returned a verdict without reading the source file, so its claims are unverified; re-launch it', retryable: true } };
  }

  const evidenceCheck = checkEvidence(parsed.data, fileText);
  const artifactId = newArtifactId(ctx, workflow, 'review');
  const review = {
    artifact_id: artifactId,
    data: parsed.data,
    for: { analysis: state.analysis.artifact_id, remediation: state.remediation ? state.remediation.artifact_id : null },
    context_id: contextId,
    isolated_context: true,
    file_reads: fileReads,
    evidence_check: evidenceCheck,
  };
  state.reviews.push(review);
  invalidateFinalReview(ctx, `${workflow} review produced ${artifactId}`);
  ctx.audit.record('artifact_created', { artifact_id: artifactId, agent: agent.id, workflow, step: 'review', verdict: parsed.data.verdict, challenges: parsed.data.challenges.length, file_reads: fileReads, evidence_unverified: evidenceCheck.unverified, context_id: contextId });
  return { ok: true, workflow, step: 'review', artifact_id: artifactId, reviewed: review.for, result: parsed.data, evidence_check: { file_quotes: evidenceCheck.file_quotes, verified: evidenceCheck.verified, unverified: evidenceCheck.unverified } };
}

// ----------------------------------------------------------- final review writer

function isReviewCurrent(state) {
  if (!state.reviews.length) return false;
  const latest = state.reviews[state.reviews.length - 1];
  return latest.for.analysis === (state.analysis && state.analysis.artifact_id) &&
    latest.for.remediation === (state.remediation ? state.remediation.artifact_id : null);
}

function buildWriterContext(ctx, workflows, notes) {
  const out = { environment: ctx.environment, workflows: {}, coordinator_notes: notes };
  for (const w of workflows) {
    const s = ctx.state[w];
    const latest = s.reviews[s.reviews.length - 1];
    out.workflows[w] = {
      analysis: s.analysis.data,
      remediation: s.remediation ? s.remediation.data : null,
      adversarial_review: { verdict: latest.data.verdict, reasoning: latest.data.reasoning, challenges: latest.data.challenges, verified_claims: latest.data.verified_claims },
      review_rounds: s.reviews.length,
    };
  }
  return out;
}

async function runFinalReviewWriter(ctx, input) {
  const notes = input && typeof input.coordinator_notes === 'string' ? input.coordinator_notes.trim() : '';
  if (!notes) return err('INVALID_TOOL_INPUT', 'coordinator_notes must be a non-empty string');
  const workflows = WORKFLOW_ORDER.filter((w) => ctx.state[w] && ctx.state[w].analysis);
  if (workflows.length === 0) return err('PRECONDITION_FAILED', 'no workflow has produced an analysis; there is nothing to write up');
  const missing = workflows.filter((w) => !isReviewCurrent(ctx.state[w]));
  if (missing.length) {
    return err('PRECONDITION_FAILED', `every executed workflow needs a current adversarial review before the report is written; missing or stale for: ${missing.join(', ')}`);
  }

  const agent = subAgent(ctx, 'final_review_writer');
  const writerContext = buildWriterContext(ctx, workflows, notes);
  const contextJson = JSON.stringify(writerContext, null, 2);
  const contextId = `writer-${crypto.randomUUID().slice(0, 8)}`;
  const resp = await ctx.client.callMessages({
    messages: [{ role: 'user', content: fillTemplate(loadPrompt(ctx, agent.prompt), { environment: ctx.environment, workflows: workflows.join(', '), context_json: contextJson }) }],
    model: ctx.model,
    maxTokens: 4096,
  });
  ctx.audit.recordLlmCall({ agent: agent.id, workflow: null, step: 'write', contextId, resp });

  const parsed = parseModelJson(resp.text, resp.stopReason);
  if (!parsed.ok) {
    ctx.audit.record('validation_failed', { agent: agent.id, step: 'write', code: parsed.error.code, message: parsed.error.message });
    return { ok: false, error: parsed.error };
  }
  const verdict = S.validateFinalReview(parsed.data, { workflows, sourceText: contextJson });
  if (!verdict.valid) {
    ctx.audit.record('validation_failed', { agent: agent.id, step: 'write', code: 'SCHEMA_VALIDATION_FAILED', details: verdict.errors });
    return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: 'final review failed validation', retryable: true, details: verdict.errors } };
  }

  const sections = {};
  for (const w of workflows) sections[w] = S.sanitizeProse(parsed.data.sections[w]);
  ctx.finalReview = {
    executive_summary: S.sanitizeProse(parsed.data.executive_summary),
    sections,
    workflows,
    coordinator_notes: notes,
    context_id: contextId,
    for_artifacts: Object.fromEntries(workflows.map((w) => [w, ctx.state[w].reviews[ctx.state[w].reviews.length - 1].artifact_id])),
  };
  ctx.audit.record('artifact_created', { artifact_id: `final-review-${contextId}`, agent: agent.id, step: 'write', workflows });
  return { ok: true, step: 'write', workflows, report_ready: true };
}

module.exports = { WORKFLOWS, WORKFLOW_ORDER, READ_FILE_TOOL, runWorkflowStep, runAdversarialReviewer, runFinalReviewWriter, isReviewCurrent, checkEvidence };
