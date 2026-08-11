/**
 * Model policy for lore (set by the user, 2026-08-04):
 * - DEFAULT_MODEL runs everything by default: NL->FilterSpec compilation, AI
 *   columns, sIVM verification sampling, experiments. Budget-tier pricing
 *   makes full-table sweeps affordable (~$1.3 per 70K-row column pass).
 * - WEB_SEARCH_MODEL is used ONLY when a task genuinely needs live web
 *   search (provider-side web tool enabled).
 * - Reasoning effort: high.
 */
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731";
export const WEB_SEARCH_MODEL = "openai/gpt-5.6-luna";
export const REASONING_EFFORT = "high" as const;

/** $ per million tokens, for pre-run estimates and the cost ledger. */
export const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  [DEFAULT_MODEL]: { in: 0.14, out: 0.28 },
  [WEB_SEARCH_MODEL]: { in: 1.25, out: 10 },
};

/** Hard ceiling for research experiment spend, set by the user. */
export const EXPERIMENT_BUDGET_USD = 50;

/**
 * Pinned decode params for cell computation. sIVM certificates are scoped to
 * a pinned (model, decode) snapshot; T=0 minimizes self-flip noise so flips
 * measure the EDIT's effect, not sampling randomness (exp0 quantifies this).
 */
export const CELL_DECODE = { temperature: 0 } as const;
