// Shared JSON extraction utility - used by all executors
function extractJSON(text) {
  // Remove markdown code fences if present
  let cleaned = text.replace(/```(json)?\s*/g, '').replace(/```\s*/g, '');

  // Find first { and matching }
  const startIdx = cleaned.indexOf('{');
  if (startIdx === -1) {
    throw new Error('No JSON object found');
  }

  let braceCount = 0;
  let endIdx = startIdx;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < cleaned.length; i++) {
    const char = cleaned[i];

    // Handle escape sequences in strings
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    // Toggle string state on unescaped quotes
    if (char === '"') {
      inString = !inString;
      continue;
    }

    // Only count braces outside of strings
    if (!inString) {
      if (char === '{') braceCount++;
      if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }

  return cleaned.substring(startIdx, endIdx + 1);
}

module.exports = { extractJSON };

// Parse a sub-agent's raw model output into a JSON object, reporting HOW it
// parsed. `bare` is true when the trimmed output was already a single JSON
// object, as every prompt requires. Anything else is tolerated at runtime
// (the evals still measure it) but is recorded in the audit trail.
function parseModelJson(text, stopReason) {
  if (stopReason === 'max_tokens') {
    return { ok: false, error: { code: 'OUTPUT_TRUNCATED', message: 'model output hit the max_tokens limit before the JSON was complete', retryable: true } };
  }
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: { code: 'EMPTY_OUTPUT', message: 'model returned no text', retryable: true } };
  const bare = trimmed.startsWith('{') && trimmed.endsWith('}');
  try {
    const data = JSON.parse(bare ? trimmed : extractJSON(trimmed));
    return { ok: true, data, bare };
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_JSON', message: `output is not valid JSON: ${err.message}`, retryable: true } };
  }
}

// Single-pass {{placeholder}} substitution. Uses a replacer function so that
// `$&`, `$'` and `$1` sequences inside substituted content (common in Terraform
// and shell-like text) are inserted literally instead of being interpreted.
function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match));
}

module.exports.parseModelJson = parseModelJson;
module.exports.fillTemplate = fillTemplate;
