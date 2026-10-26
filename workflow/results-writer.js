// Results Writer Executor: Handles all file I/O for orchestration results
// Implements dispatch-only pattern by isolating file system access

const fs = require('fs');
const path = require('path');

// Write final output and report to disk
async function writeResults(finalOutput, runId) {
  try {
    const resultsDir = path.join(__dirname, '../results');

    // Create results directory if needed
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    // Write JSON output
    const resultsFile = path.join(resultsDir, `run-${runId}-output.json`);
    fs.writeFileSync(resultsFile, JSON.stringify(finalOutput, null, 2));

    // Write markdown report
    const reportFile = path.join(resultsDir, `run-${runId}-report.md`);
    fs.writeFileSync(reportFile, finalOutput.report);

    return {
      status: 'SUCCESS',
      resultsFile,
      reportFile,
    };
  } catch (err) {
    throw new Error(`Failed to write results: ${err.message}`);
  }
}

module.exports = { writeResults };
