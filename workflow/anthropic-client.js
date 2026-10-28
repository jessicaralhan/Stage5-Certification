// Direct Anthropic Messages API client (plain HTTPS, no agentic CLI shell).
// Runtime inference never goes through `claude`, `codex`, `devin` or any other
// CLI; this file is the only network path to a model.
//
// callMessages() supports tool use (needed by the coordinator and the
// adversarial reviewer) and returns the model ID the API reports serving, which
// the audit trail records next to the model that was requested.

const { calculateCost } = require('./config');

function resolveApiUrl() {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  return `${base}/v1/messages`;
}

const API_KEY_ENV_NAMES = ['ANTHROPIC_API_KEY', 'MY_ANTHROPIC_KEY'];

function resolveApiKey() {
  for (const name of API_KEY_ENV_NAMES) {
    const value = (process.env[name] || '').trim();
    if (value) return { key: value, name };
  }
  return null;
}

const isRetryable = (status) => status === 429 || status >= 500;

/**
 * One Messages API call.
 * @returns {{content: object[], stopReason: string, inputTokens: number, outputTokens: number,
 *            model: string, requestedModel: string, responseId: string|null, text: string}}
 */
async function callMessages({ system, messages, tools, model, maxTokens = 4096, retries = 3, fetchImpl = fetch }) {
  if (!model) throw new Error('callMessages requires an explicit model (resolve it via workflow/config.js)');
  const resolved = resolveApiKey();
  if (!resolved) {
    throw new Error(`No API key found. Set one of: ${API_KEY_ENV_NAMES.join(', ')} (a local .env file is loaded by the CLI entry point).`);
  }

  const payload = { model, max_tokens: maxTokens, messages };
  if (system) payload.system = system;
  if (tools && tools.length) payload.tools = tools;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const wait = 5000 * attempt;
    let response;
    try {
      response = await fetchImpl(resolveApiUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': resolved.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(payload),
      });
    } catch (networkError) {
      lastError = new Error(`network error calling Anthropic API: ${networkError.message}`);
      if (attempt < retries) {
        process.stderr.write(`[anthropic-client] ${lastError.message} (attempt ${attempt}/${retries}), retrying in ${wait / 1000}s...\n`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw lastError;
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastError = new Error(`Anthropic API error ${response.status}: ${JSON.stringify(body)}`);
      if (isRetryable(response.status) && attempt < retries) {
        process.stderr.write(`[anthropic-client] HTTP ${response.status} (attempt ${attempt}/${retries}), retrying in ${wait / 1000}s...\n`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw lastError;
    }
    if (!body.usage || !Array.isArray(body.content)) {
      throw new Error(`Anthropic API returned an unexpected response shape: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return {
      content: body.content,
      stopReason: body.stop_reason,
      inputTokens: body.usage.input_tokens,
      outputTokens: body.usage.output_tokens,
      model: body.model || model, // what the API says actually served the call
      requestedModel: model,
      responseId: body.id || null,
      text: body.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    };
  }
  throw lastError || new Error('callMessages failed after retries');
}

// The production client object. Tests inject a scripted stand-in with the same shape.
const liveClient = { callMessages };

module.exports = { callMessages, liveClient, resolveApiKey, API_KEY_ENV_NAMES, calculateCost };
