// Persistent, append-only audit trail.
//
// Every event is appended to results/<correlation_id>/audit.jsonl the moment it
// happens (one JSON object per line, synchronous write). Nothing is held only
// in memory, so the trail survives a crash, an HTTP request ending, or the
// process exiting, and the file can be audited after the fact.
//
// The question this answers, per the Stage 4/5 audit requirement: which agent
// produced which output, on which model, with how many input and output
// tokens, at what real cost, as part of which examination.

const fs = require('fs');
const path = require('path');
const { calculateCost, pricingVerified } = require('./config');

class AuditTrail {
  constructor({ correlationId, dir }) {
    if (!correlationId) throw new Error('AuditTrail requires a correlationId');
    this.correlationId = correlationId;
    this.dir = dir;
    this.file = path.join(dir, 'audit.jsonl');
    this.seq = 0;
    fs.mkdirSync(dir, { recursive: true });
  }

  record(type, fields = {}) {
    this.seq += 1;
    const event = { seq: this.seq, correlation_id: this.correlationId, timestamp: new Date().toISOString(), type, ...fields };
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n');
    return event;
  }

  // One model call. `agent` is the manifest agent id; `step` is the specific
  // step within the workflow (for example "analyze", "remediate", "review").
  recordLlmCall({ agent, workflow = null, step, contextId, resp, turn = null }) {
    const cost = calculateCost(resp.requestedModel || resp.model, resp.inputTokens, resp.outputTokens);
    return this.record('llm_call', {
      agent,
      workflow,
      step,
      context_id: contextId,
      turn,
      requested_model: resp.requestedModel || resp.model,
      model: resp.model,
      response_id: resp.responseId || null,
      stop_reason: resp.stopReason || null,
      input_tokens: resp.inputTokens,
      output_tokens: resp.outputTokens,
      total_tokens: resp.inputTokens + resp.outputTokens,
      cost_usd: cost,
      pricing_verified: pricingVerified(resp.requestedModel || resp.model),
    });
  }
}

function readAudit(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Aggregate straight from the persisted file, never from in-memory counters.
function summarizeAudit(file) {
  const events = readAudit(file);
  const calls = events.filter((e) => e.type === 'llm_call');
  const byAgent = {};
  for (const c of calls) {
    const key = c.agent + (c.workflow ? `:${c.workflow}` : '');
    const a = (byAgent[key] = byAgent[key] || { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    a.calls += 1;
    a.input_tokens += c.input_tokens;
    a.output_tokens += c.output_tokens;
    a.cost_usd = Math.round((a.cost_usd + c.cost_usd) * 1e8) / 1e8;
  }
  const sum = (k) => calls.reduce((t, c) => t + c[k], 0);
  return {
    correlation_id: events.length ? events[0].correlation_id : null,
    events: events.length,
    llm_calls: calls.length,
    total_input_tokens: sum('input_tokens'),
    total_output_tokens: sum('output_tokens'),
    total_tokens: sum('total_tokens'),
    total_cost_usd: Math.round(sum('cost_usd') * 1e8) / 1e8,
    pricing_verified: calls.every((c) => c.pricing_verified),
    models_requested: [...new Set(calls.map((c) => c.requested_model))],
    models_reported_by_api: [...new Set(calls.map((c) => c.model))],
    by_agent: byAgent,
  };
}

module.exports = { AuditTrail, readAudit, summarizeAudit };
