require('dotenv').config({ override: true });
const fs = require('fs');
const { callClaude } = require('./workflow/anthropic-client');

(async () => {
  const promptTemplate = fs.readFileSync('./prompts/workflow2-kubernetes-analyzer.md', 'utf-8');
  const manifest = fs.readFileSync('./test-data/k8s-benign.yaml', 'utf-8');

  const content = promptTemplate
    .replace('{{manifests}}', manifest)
    .replace('{{environment}}', 'production');

  const result = await callClaude({
    user: content,
    model: 'claude-haiku-5-5',
    maxTokens: 4000,
  });

  const startIdx = result.text.indexOf('{');
  let braceCount = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < result.text.length; i++) {
    if (result.text[i] === '{') braceCount++;
    if (result.text[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        endIdx = i;
        break;
      }
    }
  }
  const jsonString = result.text.substring(startIdx, endIdx + 1);
  const parsed = JSON.parse(jsonString);

  console.log('Risk Level:', parsed.risk_level);
  console.log('Issues found:');
  parsed.security_issues.forEach((issue, i) => {
    console.log(`  ${i+1}. ${issue.type} (${issue.severity}): ${issue.description.substring(0, 100)}`);
  });
})();
