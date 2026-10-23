// Direct Anthropic Messages API client. Calls go to the real API with the
// pinned model; the response's usage block supplies the exact token counts
// recorded in the audit trail.
//
// The client accepts an optional `system` prompt, but workflow.js currently
// sends each agent's full rendered prompt as the single user message.

const DEFAULT_MODEL = 'claude-haiku-5-5';
// Some environments route Anthropic calls through an internal gateway instead
// of calling api.anthropic.com directly. Set ANTHROPIC_BASE_URL (no trailing
// slash, no /v1/messages suffix) to point at that gateway's Anthropic-shaped
// base path; it defaults to the public Anthropic API otherwise.
function resolveApiUrl() {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  return `${base}/v1/messages`;
}

function loadEnvFile(filePath) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

function isRetryable(status) {
  return status === 429 || status >= 500;
}

// Names checked for the key, in order. Claude on the web can only expose a
// variable under the name it was saved with, so both names are accepted. The
// value is never printed; callers only get the name that matched.
const API_KEY_ENV_NAMES = ['ANTHROPIC_API_KEY', 'MY_ANTHROPIC_KEY'];

function resolveApiKey() {
  for (const name of API_KEY_ENV_NAMES) {
    const value = (process.env[name] || '').trim();
    if (value) return { key: value, name };
  }
  return null;
}

// Stream-based call to bypass gateway response size limits
async function callClaudeStream({ system, user, model = DEFAULT_MODEL, maxTokens = 8192, retries = 3 }) {
  const resolved = resolveApiKey();
  if (!resolved) {
    throw new Error(
      `No API key found. Set one of these environment variables: ${API_KEY_ENV_NAMES.join(', ')}. ` +
        'For a local run, you can also put one of them in .env (see .env.example).'
    );
  }
  const apiKey = resolved.key;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const wait = 5000 * attempt;
    let response;
    try {
      response = await fetch(resolveApiUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,  // Enable streaming
          system,
          messages: [{ role: 'user', content: user }],
        }),
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

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      lastError = new Error(`Anthropic API error ${response.status}: ${JSON.stringify(body)}`);
      if (isRetryable(response.status) && attempt < retries) {
        process.stderr.write(`[anthropic-client] HTTP ${response.status} (attempt ${attempt}/${retries}), retrying in ${wait / 1000}s...\n`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw lastError;
    }

    // Process streaming response
    try {
      const text = await processStream(response);
      return {
        text,
        inputTokens: 0,  // Not available in streaming mode
        outputTokens: 0, // Not available in streaming mode
        model,
      };
    } catch (streamError) {
      lastError = new Error(`Error processing stream: ${streamError.message}`);
      if (attempt < retries) {
        process.stderr.write(`[anthropic-client] ${lastError.message} (attempt ${attempt}/${retries}), retrying in ${wait / 1000}s...\n`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('callClaudeStream failed after retries');
}

// Process SSE stream from Anthropic API
async function processStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let textContent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      accumulated += decoder.decode(value, { stream: true });
      const lines = accumulated.split('\n');

      // Process complete lines, keep incomplete line in accumulated
      accumulated = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line.startsWith(':')) continue;

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              textContent += event.delta.text;
            }
          } catch (e) {
            // Ignore parse errors for individual events
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return textContent;
}

async function callClaude({ system, user, model = DEFAULT_MODEL, maxTokens = 8192, retries = 3 }) {
  const resolved = resolveApiKey();
  if (!resolved) {
    throw new Error(
      `No API key found. Set one of these environment variables: ${API_KEY_ENV_NAMES.join(', ')}. ` +
        'For a local run, you can also put one of them in .env (see .env.example).'
    );
  }
  const apiKey = resolved.key;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const wait = 5000 * attempt;
    let response;
    try {
      response = await fetch(resolveApiUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
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
    const text = body.content.map((block) => block.text || '').join('');
    return {
      text,
      inputTokens: body.usage.input_tokens,
      outputTokens: body.usage.output_tokens,
      model,
    };
  }
  throw lastError || new Error('callClaude failed after retries');
}

// Calculate cost based on model and token counts
// Pricing: Claude Haiku 5.5 = $0.80 per 1M input tokens, $4.00 per 1M output tokens
function calculateCost(model, inputTokens, outputTokens) {
  const pricingTable = {
    'claude-haiku-5-5': {
      input: 0.80 / 1000000,  // $0.80 per 1M input tokens
      output: 4.00 / 1000000, // $4.00 per 1M output tokens
    },
  };
  const rate = pricingTable[model] || pricingTable['claude-haiku-5-5'];
  const cost = inputTokens * rate.input + outputTokens * rate.output;
  return Math.round(cost * 100000000) / 100000000; // Round to 8 decimals
}

module.exports = { callClaude, callClaudeStream, loadEnvFile, resolveApiKey, API_KEY_ENV_NAMES, DEFAULT_MODEL, calculateCost };
