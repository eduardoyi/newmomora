import type { IllustrationModel, ImageUsage } from './types';

export const IMAGE_PRICING_VERSION = 'openai-image-2026-07-23';

const USD_PER_MILLION_TOKENS: Record<IllustrationModel, {
  inputText: number;
  inputImage: number;
  outputText: number;
  outputImage: number;
}> = {
  'gpt-image-2': { inputText: 5, inputImage: 8, outputText: 30, outputImage: 30 },
  'gpt-image-1.5': { inputText: 5, inputImage: 8, outputText: 10, outputImage: 32 },
};

export interface PricedImageUsage {
  costBasis: 'provider_usage' | 'unpriced';
  costIsComplete: boolean;
  estimatedCostUsd: number | null;
}

/**
 * Keep this calculation deliberately small and versioned. The bridge stores
 * the resulting number with its version, so later price changes never rewrite
 * historical observations. Cached input has no verified image-model rate and
 * is deliberately charged at the normal input-image rate.
 */
export function priceImageUsage(model: IllustrationModel, usage: ImageUsage | null): PricedImageUsage {
  if (!usage) return { costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null };
  const values = Object.values(usage);
  if (values.some((value) => value === null)) {
    return { costBasis: 'provider_usage', costIsComplete: false, estimatedCostUsd: null };
  }
  const rates = USD_PER_MILLION_TOKENS[model];
  const cost = (
    usage.inputTextTokens! * rates.inputText +
    (usage.inputImageTokens! + usage.inputCachedTokens!) * rates.inputImage +
    usage.outputTextTokens! * rates.outputText +
    usage.outputImageTokens! * rates.outputImage
  ) / 1_000_000;
  return { costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd: cost };
}
