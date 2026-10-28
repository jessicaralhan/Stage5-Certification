const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TF_PLAN = path.join(ROOT, 'test-data', 'terraform-destructive.tf');

const tfAnalysis = {
  destructive_changes: [{ resource: 'aws_rds_cluster.prod', action: 'destroy_and_recreate', forcing_attribute: 'db_subnet_group_name', environment: 'production', severity: 'CRITICAL' }],
  security_exposure: [], cost_notes: ['Replacement briefly doubles database cost during migration.'], risk_level: 'CRITICAL',
};
const tfRemediation = {
  remediations: [{
    resource: 'aws_rds_cluster.prod', issue: 'Changing db_subnet_group_name forces replacement of the production cluster.',
    proposed_fix: 'Add lifecycle { create_before_destroy = true } and migrate via snapshot restore. Requires a production maintenance window and manual DBA review before apply.',
    fix_type: 'process_change', severity: 'CRITICAL',
  }],
};

const challenge = (over = {}) => ({
  id: 'C1', artifact: 'remediation', target: 'aws_rds_cluster.prod', severity: 'HIGH',
  claim: 'create_before_destroy does not help when the cluster identifier is fixed.',
  evidence_source: 'file', evidence: 'aws_rds_cluster.prod must be replaced', requires_human_signoff: false, ...over,
});
const review = (verdict, challenges = [], extra = {}) => ({
  verdict, reasoning: `Checked aws_rds_cluster.prod against the plan; verdict ${verdict}.`, challenges,
  verified_claims: ['aws_rds_cluster.prod is marked must be replaced in the plan'], ...extra,
});

const writerOutput = (workflows = ['terraform']) => ({
  executive_summary: 'Thank you for the careful plan. One production change needs attention before apply.',
  sections: Object.fromEntries(workflows.map((w) => [w, `The review of \`aws_rds_cluster.prod\` is complete; the CRITICAL replacement needs a human decision.`])),
});

function tmpDir(prefix = 'stage5-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const IAM_POLICY = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: 'arn:aws:s3:::reports-bucket/*' }] }, null, 2);
const iamClean = { access_issues: [], summary: 'The policy grants only s3:GetObject on one bucket path.', risk_level: 'LOW' };

module.exports = { ROOT, TF_PLAN, tfAnalysis, tfRemediation, challenge, review, writerOutput, tmpDir, IAM_POLICY, iamClean };
