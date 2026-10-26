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
  for (let i = startIdx; i < cleaned.length; i++) {
    if (cleaned[i] === '{') braceCount++;
    if (cleaned[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        endIdx = i;
        break;
      }
    }
  }

  return cleaned.substring(startIdx, endIdx + 1);
}

module.exports = { extractJSON };
