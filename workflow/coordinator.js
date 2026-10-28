// The coordinator: an LLM with one dispatch tool per sub-agent and nothing else.
//
// What the LLM decides (its reasoning, not if/while code here): which workflow
// to launch, whether to remediate, when to call the adversarial reviewer, whether
// to re-invoke a sub-agent with reviewer challenges and which artifact to target,
// when the loop has settled, and whether to approve or escalate.
//
// What this code enforces (structure, not judgment): the tool surface is exactly
// the manifest's launch_* tools; sub-agent outputs are schema-validated before
// the coordinator sees them; budgets and revision caps; and after the loop, the
// deterministic hard gates, which the coordinator cannot approve past.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { liveClient } = require('./anthropic-client');
const { resolveModel } = require('./config');
const { AuditTrail, summarizeAudit } = require('./audit');
const { fillTemplate, parseModelJson } = require('./json-utils');
const S = require('./schemas');
const { evaluateHardGates, evaluateSubstance, computeFinalStatus } = require('./gates');
const { assembleReport } = require('./report');
const sub = require('./subagents');

const ROOT = path.join(__dirname, '..');

const HANDLERS = {
  terraform_workflow: (ctx, input) => sub.runWorkflowStep(ctx, 'terraform', input),
  kubernetes_workflow: (ctx, input) => sub.runWorkflowStep(ctx, 'kubernetes', input),
  iam_workflow: (ctx, input) => sub.runWorkflowStep(ctx, 'iam', input),
  adversarial_reviewer: (ctx, input) => sub.runAdversarialReviewer(ctx, input),
  final_review_writer: (ctx, input) => sub.runFinalReviewWriter(ctx, input),
};

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// The dispatch-only rule, enforced in code. A coordinator holding read_file,
// http_get, bash or any other real-work tool is the mega-agent counterfeit; the
// system refuses to start with such a manifest.
function assertDispatchOnly(manifest) {
  const bad = manifest.coordinator.tools.filter((t) => !/^launch_[a-z_]+$/.test(t.name));
  if (bad.length) throw new Error(`coordinator manifest holds non-dispatch tool(s): ${bad.map((t) => t.name).join(', ')}. Only launch_* tools are allowed.`);
  for (const t of manifest.coordinator.tools) {
    if (!HANDLERS[t.dispatches_to]) throw new Error(`coordinator tool ${t.name} dispatches to unknown sub-agent "${t.dispatches_to}"`);
  }
  return true;
}

// The exact tool definitions sent to the API: declared name, description and schema only.
function buildCoordinatorTools(manifest) {
  assertDispatchOnly(manifest);
  return manifest.coordinator.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

async function dispatch(ctx, block) {
  const tool = ctx.manifest.coordinator.tools.find((t) => t.name === block.name);
  if (!tool) {
    ctx.audit.record('blocked_tool_call', { agent: 'coordinator', tool: block.name, reason: 'not in the coordinator manifest' });
    return { ok: false, error: { code: 'TOOL_NOT_AVAILABLE', message: `${block.name} is not one of your tools. You may only dispatch: ${ctx.manifest.coordinator.tools.map((t) => t.name).join(', ')}`, retryable: false } };
  }
  ctx.dispatches += 1;
  if (ctx.dispatches > ctx.manifest.coordinator.limits.max_dispatches) {
    ctx.audit.record('dispatch_refused', { tool: block.name, reason: 'BUDGET_EXHAUSTED', dispatches: ctx.dispatches });
    return { ok: false, error: { code: 'BUDGET_EXHAUSTED', message: `dispatch budget of ${ctx.manifest.coordinator.limits.max_dispatches} is used up; finish and escalate any unresolved work`, retryable: false } };
  }
  ctx.audit.record('dispatch', { tool: block.name, dispatches_to: tool.dispatches_to, input: block.input });
  let result;
  try {
    result = await HANDLERS[tool.dispatches_to](ctx, block.input || {});
  } catch (e) {
    // A crash inside a sub-agent becomes a structured error, never a thrown exception into the loop.
    ctx.audit.record('sub_agent_exception', { tool: block.name, message: e.message });
    result = { ok: false, error: { code: 'SUB_AGENT_EXCEPTION', message: e.message, retryable: false } };
  }
  ctx.audit.record('tool_result', { tool: block.name, ok: result.ok, error_code: result.ok ? null : result.error.code, artifact_id: result.artifact_id || null });
  return result;
}

async function runCoordinatorLoop(ctx) {
  const tools = buildCoordinatorTools(ctx.manifest);
  const stats = fs.statSync(ctx.inputFile);
  const system = fillTemplate(fs.readFileSync(path.join(ROOT, ctx.manifest.coordinator.prompt), 'utf8'), {
    correlation_id: ctx.correlationId,
    input_name: ctx.inputName,
    extension: path.extname(ctx.inputName) || '(none)',
    size_bytes: stats.size,
    environment: ctx.environment,
    max_dispatches: ctx.manifest.coordinator.limits.max_dispatches,
    max_revisions: ctx.manifest.coordinator.limits.max_remediation_revisions_per_workflow,
  });
  const messages = [{ role: 'user', content: 'Begin the examination.' }];
  const contextId = `coordinator-${ctx.correlationId}`;

  for (let turn = 1; turn <= ctx.manifest.coordinator.limits.max_turns; turn++) {
    const resp = await ctx.client.callMessages({ system, messages, tools, model: ctx.model, maxTokens: 2048 });
    ctx.audit.recordLlmCall({ agent: 'coordinator', step: 'coordinate', contextId, resp, turn });
    ctx.turns = turn;
    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stopReason !== 'tool_use') return { finished: true, text: resp.text, stopReason: resp.stopReason };

    const results = [];
    for (const block of resp.content.filter((b) => b.type === 'tool_use')) {
      const result = await dispatch(ctx, block);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result), is_error: !result.ok });
    }
    messages.push({ role: 'user', content: results });
  }
  return { finished: false, text: '', stopReason: 'max_turns' };
}

/**
 * Run one complete examination.
 * `client` is injectable: the live HTTP client in production, a scripted stand-in in tests.
 */
async function runExamination({
  inputFile, environment, client = liveClient, model = resolveModel(),
  resultsDir = path.join(ROOT, 'results'), rootDir = ROOT, correlationId,
  manifest = loadJson('agents.manifest.json'), substanceDoc = loadJson('substance.json'),
}) {
  if (!['production', 'non-production'].includes(environment)) throw new Error('environment must be "production" or "non-production"');
  const absInput = path.resolve(inputFile);
  if (!fs.existsSync(absInput)) throw new Error(`input file not found: ${inputFile}`);
  assertDispatchOnly(manifest);

  const cid = correlationId || `exam-${crypto.randomUUID()}`;
  const dir = path.join(resultsDir, cid);
  const audit = new AuditTrail({ correlationId: cid, dir });
  const startedAt = new Date().toISOString();
  const inputBuf = fs.readFileSync(absInput);

  const ctx = {
    correlationId: cid, client, model, manifest, rootDir, audit, environment,
    inputFile: absInput, inputName: path.basename(absInput),
    state: {}, finalReview: null, artifactSeq: 0, revisions: {}, dispatches: 0, turns: 0,
  };

  const substance = evaluateSubstance(substanceDoc);
  audit.record('examination_started', {
    input: ctx.inputName, input_sha256: crypto.createHash('sha256').update(inputBuf).digest('hex'), input_bytes: inputBuf.length,
    environment, requested_model: model, coordinator_tools: manifest.coordinator.tools.map((t) => t.name),
  });
  audit.record('substance_assessment', { elevate: substance.elevate, counts: substance.counts, reasons: substance.reasons });

  let loop;
  let incompleteReason = null;
  try {
    loop = await runCoordinatorLoop(ctx);
  } catch (e) {
    audit.record('coordinator_error', { message: e.message });
    loop = { finished: false, text: '', stopReason: 'error' };
    incompleteReason = `coordinator failed: ${e.message}`;
  }

  let disposition = null;
  if (loop.finished) {
    const parsed = parseModelJson(loop.text, loop.stopReason);
    if (parsed.ok && S.validateDisposition(parsed.data).valid) disposition = parsed.data;
    else incompleteReason = incompleteReason || 'the coordinator did not return a valid disposition';
  } else {
    incompleteReason = incompleteReason || `the coordinator did not finish (${loop.stopReason})`;
  }
  if (Object.keys(ctx.state).length === 0) incompleteReason = incompleteReason || 'the coordinator dispatched no workflow';
  if (!ctx.finalReview) incompleteReason = incompleteReason || 'the final review writer did not complete for the final state of the artifacts';
  audit.record('disposition', { disposition, incomplete_reason: incompleteReason });

  // Deterministic stage: the coordinator cannot approve past any of this.
  const gateResult = evaluateHardGates({ state: ctx.state, environment });
  const finalStatus = computeFinalStatus({ gateResult, substance, disposition, incompleteReason });
  audit.record('gate_result', { gates: gateResult.gates, requires_human_decision: finalStatus.requires_human_decision, final_status: finalStatus.final_status, coordinator_overridden: finalStatus.coordinator_overridden });

  const auditSummary = summarizeAudit(audit.file);
  const { markdown, statuses, overall } = assembleReport({
    correlationId: cid, environment, inputName: ctx.inputName, state: ctx.state, gates: gateResult.gates,
    finalReview: ctx.finalReview, disposition, finalStatus, substance, audit: auditSummary,
  });
  fs.writeFileSync(path.join(dir, 'report.md'), markdown);

  const run = {
    correlation_id: cid,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    input: { name: ctx.inputName, bytes: inputBuf.length, sha256: crypto.createHash('sha256').update(inputBuf).digest('hex') },
    environment,
    model: { requested: model, reported_by_api: auditSummary.models_reported_by_api },
    coordinator: { turns: ctx.turns, dispatches: ctx.dispatches, tools: manifest.coordinator.tools.map((t) => t.name), disposition, incomplete_reason: incompleteReason },
    workflows: ctx.state,
    workflow_status: statuses,
    overall_result: overall,
    gates: gateResult.gates,
    substance,
    requires_human_decision: finalStatus.requires_human_decision,
    final_status: finalStatus.final_status,
    final_status_reasons: finalStatus.reasons,
    coordinator_overridden: finalStatus.coordinator_overridden,
    files: { run: `results/${cid}/run.json`, report: `results/${cid}/report.md`, audit: `results/${cid}/audit.jsonl` },
    audit_summary: auditSummary,
  };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}

module.exports = { runExamination, buildCoordinatorTools, assertDispatchOnly, HANDLERS };
