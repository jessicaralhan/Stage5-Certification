// Single source of truth for model selection and pricing. Every agent in the
// system (coordinator, examiners, adversarial reviewer, final review writer)
// resolves its model from here, so the audit trail can never disagree with the
// code about which model ran.
//
// Override with STAGE5_MODEL (for example to move to claude-haiku-5-5 through
// an internal gateway). An unknown model fails fast at startup, before any
// tokens are spent, rather than mid-run.

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Rates are USD per million tokens. `verified: false` means the rate has NOT
// been checked against https://www.anthropic.com/pricing and the audit trail
// says so on every cost line. The earlier value for Haiku 4.5 here ($0.80 in /
// $4.00 out) was the Haiku 3.5 rate; it has been corrected to the published
// Haiku 4.5 list price, still flagged unverified until someone confirms it.
const PRICING = {
  'claude-haiku-4-5-20251001': { inPerMTok: 1.0, outPerMTok: 5.0, verified: false },
  'claude-haiku-5-5': { inPerMTok: 0.1, outPerMTok: 0.5, verified: false },
};

function resolveModel() {
  const model = (process.env.STAGE5_MODEL || DEFAULT_MODEL).trim();
  if (!PRICING[model]) {
    throw new Error(
      `Model "${model}" has no entry in workflow/config.js PRICING. Known models: ${Object.keys(PRICING).join(', ')}. ` +
        'Add a priced entry before running; unpriced costs are never recorded.'
    );
  }
  return model;
}

function calculateCost(model, inputTokens, outputTokens) {
  const rate = PRICING[model];
  if (!rate) throw new Error(`no pricing configured for model ${model}; refusing to record an unpriced cost`);
  const cost = (inputTokens / 1e6) * rate.inPerMTok + (outputTokens / 1e6) * rate.outPerMTok;
  return Math.round(cost * 1e8) / 1e8;
}

function pricingVerified(model) {
  return Boolean(PRICING[model] && PRICING[model].verified);
}

module.exports = { DEFAULT_MODEL, PRICING, resolveModel, calculateCost, pricingVerified };
