// Approximate LLM pricing for COST DISPLAY only (not billing). USD per 1,000,000
// tokens, split input/output — the split matters because output is 3-5x input,
// and the dashboard previously used a single flat $2/M blended rate that
// underestimated real spend 5-20x on premium models.
//
// EDITABLE: verify against the live OpenRouter price list before relying on it.
// findModelPrice falls back to the catalog tier, then to a conservative default,
// so an unknown model is never priced at zero.

import { findCatalogModel, type ModelTier } from "./model-catalog";

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
}

const PER_MILLION: Record<string, ModelPrice> = {
  "anthropic/claude-opus-4.8": { input: 15, output: 75 },
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15 },
  "anthropic/claude-haiku-4.5": { input: 0.8, output: 4 },
  "openai/gpt-5.5": { input: 10, output: 30 },
  "openai/gpt-5.4": { input: 6, output: 18 },
  "openai/gpt-5.2": { input: 3, output: 12 },
  "openai/gpt-4.1": { input: 2, output: 8 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "google/gemini-3.5-flash": { input: 0.3, output: 2.5 },
  "google/gemini-3.1-flash-lite": { input: 0.1, output: 0.4 },
  "google/gemini-3.1-pro-preview": { input: 3.5, output: 10.5 },
  // Legacy fallback model id still used as a default in a few places.
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
};

// Tier fallback when the exact id isn't in the table but is in the catalog.
const TIER_PRICE: Record<ModelTier, ModelPrice> = {
  premium: { input: 10, output: 30 },
  balanced: { input: 3, output: 12 },
  fast: { input: 0.4, output: 1.6 },
};

// Conservative default for a completely unknown model — deliberately NOT cheap,
// so we never silently underestimate.
const DEFAULT_PRICE: ModelPrice = { input: 3, output: 12 };

export function findModelPrice(model: string | null | undefined): ModelPrice {
  if (model && PER_MILLION[model]) return PER_MILLION[model];
  const catalog = findCatalogModel(model);
  if (catalog) return TIER_PRICE[catalog.model.tier];
  return DEFAULT_PRICE;
}

/** Estimated USD cost for one LLM call, weighted by model and input/output. */
export function estimateCostUsd(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = findModelPrice(model);
  return (
    (promptTokens / 1_000_000) * price.input +
    (completionTokens / 1_000_000) * price.output
  );
}
