# Stage 3 eval results

Generated 2026-10-28T08:49:50.420Z by `node evals/run-evals.js`. Every number below was produced by a run; nothing here is hand-written.

| Agent | Prompts | Cases | Named criteria | Checks passed | Pass rate | Model | Cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| terraform_workflow | prompts/workflow1-terraform-analyzer.md, prompts/workflow1-terraform-generator.md | 3 | 11 | 13/16 | 81% | claude-haiku-4-5-20251001 | 0.013388 |
| kubernetes_workflow | prompts/workflow2-kubernetes-analyzer.md, prompts/workflow2-kubernetes-generator.md | 3 | 9 | 10/13 | 77% | claude-haiku-4-5-20251001 | 0.023510 |
| iam_workflow | prompts/workflow3-iam-analyzer.md, prompts/workflow3-iam-generator.md | 2 | 7 | 7/9 | 78% | claude-haiku-4-5-20251001 | 0.018236 |
| adversarial_reviewer | prompts/adversarial-reviewer.md | 2 | 7 | 0/10 | 0% | claude-haiku-4-5-20251001 | 0.014248 |
| final_review_writer | prompts/final-review-writer.md | 1 | 4 | 4/4 | 100% | claude-haiku-4-5-20251001 | 0.002901 |

Target pass rate per agent: 95%. Per-criterion rates and failure details are in each `<agent>.results.json`.

## Failing checks

- terraform_workflow / prod-destructive-replacement / bare-json-output: output was wrapped in prose or code fences
- terraform_workflow / benign-plan-no-false-positives / bare-json-output: output was wrapped in prose or code fences
- terraform_workflow / open-cidr-ssh / bare-json-output: output was wrapped in prose or code fences
- kubernetes_workflow / rbac-wildcard-binding / bare-json-output: output was wrapped in prose or code fences
- kubernetes_workflow / insecure-pod / bare-json-output: output was wrapped in prose or code fences
- kubernetes_workflow / hardened-manifest-not-critical / bare-json-output: output was wrapped in prose or code fences
- iam_workflow / wildcard-action-and-resource / bare-json-output: output was wrapped in prose or code fences
- iam_workflow / least-privilege-not-critical / bare-json-output: output was wrapped in prose or code fences
- adversarial_reviewer / prevent-destroy-trap / schema-valid: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM6zZ9xLcAPyg5B1qnK"}
- adversarial_reviewer / prevent-destroy-trap / does-not-approve-flawed-fix: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM6zZ9xLcAPyg5B1qnK"}
- adversarial_reviewer / prevent-destroy-trap / catches-self-defeating-fix: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM6zZ9xLcAPyg5B1qnK"}
- adversarial_reviewer / prevent-destroy-trap / verifies-against-source-file: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM6zZ9xLcAPyg5B1qnK"}
- adversarial_reviewer / prevent-destroy-trap / file-quotes-are-genuine: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM6zZ9xLcAPyg5B1qnK"}
- adversarial_reviewer / prevent-destroy-trap / escalates-prod-replacement: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM6zZ9xLcAPyg5B1qnK"}
- adversarial_reviewer / analysis-missed-a-finding / schema-valid: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM7rN4PfhyHYF6zjyDZ"}
- adversarial_reviewer / analysis-missed-a-finding / catches-missed-finding: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM7rN4PfhyHYF6zjyDZ"}
- adversarial_reviewer / analysis-missed-a-finding / verifies-against-source-file: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM7rN4PfhyHYF6zjyDZ"}
- adversarial_reviewer / analysis-missed-a-finding / file-quotes-are-genuine: case failed to run: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: user messages must have non-empty content"},"request_id":"req_011CgUM7rN4PfhyHYF6zjyDZ"}
