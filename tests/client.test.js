// The live HTTP client, exercised against a fake fetch (no network, no key needed).
const test = require('node:test');
const assert = require('node:assert');
const { callMessages } = require('../workflow/anthropic-client');

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const SECRET = 'sk-ant-test-secret-value-123';

function withKey(fn) {
  const saved = { a: process.env.ANTHROPIC_API_KEY, m: process.env.MY_ANTHROPIC_KEY, b: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = SECRET; delete process.env.MY_ANTHROPIC_KEY; delete process.env.ANTHROPIC_BASE_URL;
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['MY_ANTHROPIC_KEY', saved.m], ['ANTHROPIC_BASE_URL', saved.b]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

test('sends tools, system and messages; returns tool_use blocks, usage and the model the API reports', () => withKey(async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return okResponse({ id: 'msg_1', model: 'claude-haiku-4-5-20251001', stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 7 }, content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_1', name: 'launch_terraform_workflow', input: { step: 'analyze' } }] });
  };
  const tools = [{ name: 'launch_terraform_workflow', description: 'd', input_schema: { type: 'object' } }];
  const r = await callMessages({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools, model: 'claude-haiku-4-5-20251001', fetchImpl });
  assert.strictEqual(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(seen.init.headers['x-api-key'], SECRET);
  assert.deepStrictEqual(seen.body.tools, tools);
  assert.strictEqual(seen.body.system, 'sys');
  assert.strictEqual(seen.body.model, 'claude-haiku-4-5-20251001');
  assert.strictEqual(r.stopReason, 'tool_use');
  assert.strictEqual(r.content.find((b) => b.type === 'tool_use').id, 'toolu_1');
  assert.strictEqual(r.inputTokens, 11); assert.strictEqual(r.outputTokens, 7);
  assert.strictEqual(r.model, 'claude-haiku-4-5-20251001');
  assert.strictEqual(r.text, 'ok');
}));

test('omits tools/system when none are given, honors ANTHROPIC_BASE_URL, and records a different served model', () => withKey(async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/anthropic/';
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return okResponse({ model: 'served-model-x', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{}' }] }); };
  const r = await callMessages({ messages: [{ role: 'user', content: 'x' }], model: 'claude-haiku-4-5-20251001', fetchImpl });
  assert.strictEqual(seen.url, 'https://gateway.example.com/anthropic/v1/messages');
  assert.ok(!('tools' in seen.body) && !('system' in seen.body));
  assert.strictEqual(r.model, 'served-model-x');
  assert.strictEqual(r.requestedModel, 'claude-haiku-4-5-20251001');
}));

test('non-retryable API errors surface without leaking the API key', () => withKey(async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { type: 'invalid_request_error', message: 'bad' } }) });
  await assert.rejects(() => callMessages({ messages: [], model: 'm', retries: 3, fetchImpl }), (e) => {
    assert.match(e.message, /400/);
    assert.ok(!e.message.includes(SECRET));
    return true;
  });
}));

test('it refuses to run without an explicit model or without an API key, and never prints the key', async () => {
  await assert.rejects(() => callMessages({ messages: [] }), /explicit model/);
  const saved = [process.env.ANTHROPIC_API_KEY, process.env.MY_ANTHROPIC_KEY];
  delete process.env.ANTHROPIC_API_KEY; delete process.env.MY_ANTHROPIC_KEY;
  await assert.rejects(() => callMessages({ messages: [], model: 'm', fetchImpl: async () => { throw new Error('should not be called'); } }), /No API key found/);
  if (saved[0] !== undefined) process.env.ANTHROPIC_API_KEY = saved[0];
  if (saved[1] !== undefined) process.env.MY_ANTHROPIC_KEY = saved[1];
});

test('malformed API responses are rejected rather than passed on', () => withKey(async () => {
  const fetchImpl = async () => okResponse({ nope: true });
  await assert.rejects(() => callMessages({ messages: [], model: 'm', fetchImpl }), /unexpected response shape/);
}));
