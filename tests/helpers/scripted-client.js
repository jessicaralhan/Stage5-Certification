// A scripted stand-in for the Anthropic client, used only by tests and by the
// evals' --offline self-check. It has the same shape as the live client
// (callMessages) and returns canned, deterministic responses, so the harness's
// guardrails, gates and audit trail can be verified without an API key.

const MODEL = 'claude-haiku-4-5-20251001';

function response({ content, stopReason = 'end_turn', inputTokens = 1000, outputTokens = 200 }) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return {
    content: blocks, stopReason, inputTokens, outputTokens, model: MODEL, requestedModel: MODEL,
    responseId: 'msg_test', text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
  };
}

function lastToolResults(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result') out.push({ tool_use_id: b.tool_use_id, is_error: b.is_error, body: safeParse(b.content) });
    }
  }
  return out;
}
const safeParse = (s) => { try { return JSON.parse(s); } catch (e) { return s; } };

/**
 * @param {object} cfg
 *   cfg.coordinator(results, messages) -> { tool, input } | { tools:[{tool,input}] } | { final: object|string }
 *   cfg.analyzer(prompt)   -> string   (any workflow analyze step)
 *   cfg.generator(prompt)  -> string   (any workflow remediate step)
 *   cfg.reviewer(prompt, n)-> string   (n = review number, 1-based) ; cfg.reviewerReadsFile (default true)
 *   cfg.writer(prompt)     -> string
 */
function createScriptedClient(cfg) {
  const calls = [];
  let reviewNo = 0;
  let toolSeq = 0;
  const client = {
    calls,
    async callMessages(req) {
      calls.push(JSON.parse(JSON.stringify(req)));
      const names = (req.tools || []).map((t) => t.name);

      if (names.some((n) => n.startsWith('launch_'))) {
        const results = lastToolResults(req.messages);
        const step = cfg.coordinator(results, req.messages);
        if (step.final !== undefined) return response({ content: typeof step.final === 'string' ? step.final : JSON.stringify(step.final), outputTokens: 120 });
        const list = step.tools || [step];
        return response({
          stopReason: 'tool_use', outputTokens: 80,
          content: list.map((s) => ({ type: 'tool_use', id: `toolu_${++toolSeq}`, name: s.tool, input: s.input || {} })),
        });
      }

      if (names.includes('read_file')) {
        const lastUser = req.messages[req.messages.length - 1];
        const hasToolResult = Array.isArray(lastUser.content) && lastUser.content.some((b) => b.type === 'tool_result');
        if (!hasToolResult && cfg.reviewerReadsFile !== false) {
          const inputName = (req.messages[0].content.match(/Source file: (\S+)/) || [])[1];
          return response({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${++toolSeq}`, name: 'read_file', input: { path: cfg.reviewerPath || inputName } }] });
        }
        if (!hasToolResult || hasToolResult) {
          reviewNo += 1;
          return response({ content: cfg.reviewer(req.messages[0].content, reviewNo, req.messages), outputTokens: 400 });
        }
      }

      const prompt = req.messages[0].content;
      if (/final review writer/i.test(prompt)) return response({ content: cfg.writer(prompt), outputTokens: 500 });
      if (/Reviewer challenges to address/.test(prompt)) return response({ content: cfg.generator(prompt), outputTokens: 300 });
      if (/Reviewer challenges to reconsider/.test(prompt)) return response({ content: cfg.analyzer(prompt), outputTokens: 300 });
      throw new Error('scripted client: unrecognized request');
    },
  };
  return client;
}

module.exports = { createScriptedClient, response, MODEL };
