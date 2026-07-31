/**
 * Normalized, content-free measurements accepted from OpenAI responses.
 * Keep this module deliberately independent from response payload types: API
 * shapes evolve, while the ledger must only ever receive these scalar fields.
 */
export interface AiUsageDimensions {
  input_text_tokens?: number;
  input_image_tokens?: number;
  cached_input_tokens?: number;
  output_text_tokens?: number;
  output_image_tokens?: number;
  audio_seconds?: number;
}

export interface PricedAiUsage {
  dimensions: AiUsageDimensions;
  billingStatus: 'known' | 'unknown';
  pricingVersion: string | null;
  costBasis: 'provider_usage' | 'request_shape_estimate' | 'unpriced';
  costIsComplete: boolean;
  estimatedCostUsd: number | null;
}

const PRICING_VERSION = 'openai-2026-07-27';

type KnownModel = 'gpt-4o-mini' | 'gpt-4o-mini-transcribe' | 'gpt-image-2' | 'gpt-image-1.5';

const PER_MILLION_USD: Record<Exclude<KnownModel, 'gpt-4o-mini-transcribe'>, {
  inputText: number;
  inputImage: number;
  cachedInput: number;
  outputText: number;
  outputImage: number;
}> = {
  // These rates are intentionally versioned with the persisted result. Do not
  // silently edit them after deployment; add a new version instead.
  'gpt-4o-mini': { inputText: 0.15, inputImage: 0.15, cachedInput: 0.075, outputText: 0.60, outputImage: 0.60 },
  'gpt-image-2': { inputText: 5, inputImage: 8, cachedInput: 8, outputText: 30, outputImage: 30 },
  'gpt-image-1.5': { inputText: 5, inputImage: 8, cachedInput: 8, outputText: 10, outputImage: 32 },
};

const TRANSCRIBE_USD_PER_AUDIO_SECOND = 0.003 / 60;
const TRANSCRIBE_INPUT_TEXT_USD_PER_MILLION = 1.25;
const TRANSCRIBE_OUTPUT_TEXT_USD_PER_MILLION = 5;

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Supports current Responses/chat/image usage payloads and older chat fields.
 * It never returns arbitrary provider keys or response text.
 */
export function normalizeOpenAiUsage(value: unknown, knownAudioSeconds?: number): AiUsageDimensions {
  const usage = object(value);
  const inputDetails = object(usage.input_tokens_details);
  const outputDetails = object(usage.output_tokens_details);
  const dimensions: AiUsageDimensions = {
    input_text_tokens: nonNegativeNumber(inputDetails.text_tokens) ?? nonNegativeNumber(usage.input_text_tokens) ?? nonNegativeNumber(usage.prompt_tokens) ?? nonNegativeNumber(usage.input_tokens),
    input_image_tokens: nonNegativeNumber(inputDetails.image_tokens) ?? nonNegativeNumber(usage.input_image_tokens),
    cached_input_tokens: nonNegativeNumber(inputDetails.cached_tokens) ?? nonNegativeNumber(usage.input_cached_tokens),
    output_text_tokens: nonNegativeNumber(outputDetails.text_tokens) ?? nonNegativeNumber(usage.output_text_tokens) ?? nonNegativeNumber(usage.completion_tokens) ?? nonNegativeNumber(usage.output_tokens),
    output_image_tokens: nonNegativeNumber(outputDetails.image_tokens) ?? nonNegativeNumber(usage.output_image_tokens),
    audio_seconds: nonNegativeNumber(usage.audio_seconds) ?? nonNegativeNumber(usage.duration) ?? knownAudioSeconds,
  };
  return Object.fromEntries(Object.entries(dimensions).filter(([, metric]) => metric !== undefined)) as AiUsageDimensions;
}

function hasValue(dimensions: AiUsageDimensions, key: keyof AiUsageDimensions): boolean {
  return dimensions[key] !== undefined;
}

export function priceOpenAiUsage(
  model: string,
  dimensions: AiUsageDimensions,
  options: { audioDurationIsEstimate?: boolean } = {},
): PricedAiUsage {
  const hasDimensions = Object.keys(dimensions).length > 0;
  if (model === 'gpt-4o-mini-transcribe') {
    const hasBillableDimension = hasValue(dimensions, 'audio_seconds') ||
      hasValue(dimensions, 'input_text_tokens') || hasValue(dimensions, 'output_text_tokens');
    if (!hasBillableDimension) {
      return { dimensions, billingStatus: hasDimensions ? 'known' : 'unknown', pricingVersion: PRICING_VERSION, costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null };
    }
    const estimatedCostUsd =
      (dimensions.audio_seconds ?? 0) * TRANSCRIBE_USD_PER_AUDIO_SECOND +
      (dimensions.input_text_tokens ?? 0) * TRANSCRIBE_INPUT_TEXT_USD_PER_MILLION / 1_000_000 +
      (dimensions.output_text_tokens ?? 0) * TRANSCRIBE_OUTPUT_TEXT_USD_PER_MILLION / 1_000_000;
    return {
      dimensions,
      billingStatus: 'known',
      pricingVersion: PRICING_VERSION,
      costBasis: options.audioDurationIsEstimate ? 'request_shape_estimate' : 'provider_usage',
      // An audio-only fallback is useful as a request-shape estimate but it
      // cannot stand in for the model's separate input/output text charges.
      costIsComplete: !options.audioDurationIsEstimate &&
        hasValue(dimensions, 'audio_seconds') &&
        hasValue(dimensions, 'input_text_tokens') &&
        hasValue(dimensions, 'output_text_tokens'),
      estimatedCostUsd,
    };
  }

  const rates = PER_MILLION_USD[model as Exclude<KnownModel, 'gpt-4o-mini-transcribe'>];
  if (!rates || !hasDimensions) {
    return { dimensions, billingStatus: hasDimensions ? 'known' : 'unknown', pricingVersion: rates ? PRICING_VERSION : null, costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null };
  }

  // A price is complete only when every billable dimension for this model's
  // response shape is known. Missing image dimensions are zero for chat; the
  // inverse is not true for image generation, whose usage must be itemized.
  const isImage = model === 'gpt-image-2' || model === 'gpt-image-1.5';
  const required = isImage
    ? ['input_text_tokens', 'input_image_tokens', 'cached_input_tokens', 'output_text_tokens', 'output_image_tokens'] as const
    : ['input_text_tokens', 'output_text_tokens'] as const;
  if (required.some((key) => !hasValue(dimensions, key))) {
    return { dimensions, billingStatus: 'known', pricingVersion: PRICING_VERSION, costBasis: 'provider_usage', costIsComplete: false, estimatedCostUsd: null };
  }

  const cost = (
    (dimensions.input_text_tokens ?? 0) * rates.inputText +
    (dimensions.input_image_tokens ?? 0) * rates.inputImage +
    (dimensions.cached_input_tokens ?? 0) * rates.cachedInput +
    (dimensions.output_text_tokens ?? 0) * rates.outputText +
    (dimensions.output_image_tokens ?? 0) * rates.outputImage
  ) / 1_000_000;
  return { dimensions, billingStatus: 'known', pricingVersion: PRICING_VERSION, costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd: cost };
}
