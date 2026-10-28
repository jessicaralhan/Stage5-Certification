// Custom harness only: runtime inference must never go through an agentic CLI shell.
// Scans the runtime source (not tests/ or evals/, which are exempt).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_DIRS = ['workflow', 'punch-out'];
const files = RUNTIME_DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));

test('no runtime module uses child processes or shells out to an agentic CLI', () => {
  assert.ok(files.length >= 8);
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, /child_process|\bspawn(Sync)?\s*\(|\bexec(Sync|File)?\s*\(/, `${f} must not spawn processes`);
    assert.doesNotMatch(src, /['"`](claude|codex|devin|aider|gemini)\s+(-p|--print|run|exec|chat)\b/, `${f} must not invoke an agentic CLI`);
  }
});

test('the only network path to a model is the direct Messages API client', () => {
  const callers = files.filter((f) => /callMessages\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')) && !/anthropic-client/.test(f));
  for (const f of callers) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /ctx\.client\.callMessages|client\.callMessages|callMessages\(/);
  const client = fs.readFileSync(path.join(ROOT, 'workflow', 'anthropic-client.js'), 'utf8');
  assert.match(client, /\/v1\/messages/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!JSON.stringify(pkg.scripts).match(/\bclaude\b|\bcodex\b|\bdevin\b/), 'no npm script runs an agentic CLI');
});
