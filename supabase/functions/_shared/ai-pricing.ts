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

const LEGACY_PRICING_VERSION = 'openai-2026-07-27';

type KnownModel = 'gpt-4o-mini' | 'gpt-4o-mini-transcribe' | 'gpt-image-2.5-flare' | 'gpt-image-2' | 'gpt-image-1.5' | 'gpt-6-sol' | 'gpt-6.1-sol' | 'gpt-6-luna';

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
  'gpt-image-2.5-flare': { inputText: 5, inputImage: 8, cachedInput: 8, outputText: 0, outputImage: 30 },
  'gpt-image-1.5': { inputText: 5, inputImage: 8, cachedInput: 8, outputText: 10, outputImage: 32 },
  // Year Film quote pick / claim + frame checks (pricing version openai-2026-09-28).
  'gpt-6-sol': { inputText: 2, inputImage: 2, cachedInput: 0.2, outputText: 10, outputImage: 10 },
  'gpt-6-luna': { inputText: 0.1, inputImage: 0.1, cachedInput: 0.01, outputText: 0.5, outputImage: 0.5 },
  // Holiday card film claim checks / quote pick (pricing version openai-2026-09-29; standard tier, short context).
  'gpt-6.1-sol': { inputText: 2, inputImage: 2, cachedInput: 0.1, outputText: 10, outputImage: 10 },
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

/** Audio tokens from a Chat Completions usage payload (they are included in
 * prompt_tokens / completion_tokens, so callers subtract them from the text
 * counts before pricing). */
export function openAiAudioTokens(value: unknown): { input: number; output: number } {
  const usage = object(value);
  return {
    input: nonNegativeNumber(object(usage.prompt_tokens_details).audio_tokens) ?? 0,
    output: nonNegativeNumber(object(usage.completion_tokens_details).audio_tokens) ?? 0,
  };
}

// gpt-audio chat models (Year Film voice check), per 1M tokens — OpenAI
// pricing page, read 2026-09-29. Versioned with the result: add, don't edit.
const AUDIO_CHAT_PRICING_VERSION = 'openai-2026-09-29';
const AUDIO_CHAT_USD_PER_MILLION: Record<string, { audioIn: number; audioOut: number; textIn: number; textOut: number }> = {
  'gpt-audio-1.5': { audioIn: 32, audioOut: 64, textIn: 2.5, textOut: 10 },
  'gpt-audio': { audioIn: 32, audioOut: 64, textIn: 2.5, textOut: 10 },
  'gpt-audio-mini': { audioIn: 10, audioOut: 20, textIn: 0.6, textOut: 2.4 },
};

export function priceOpenAiUsage(
  model: string,
  dimensions: AiUsageDimensions,
  options: { audioDurationIsEstimate?: boolean; audioInputTokens?: number; audioOutputTokens?: number } = {},
): PricedAiUsage {
  const audioRates = AUDIO_CHAT_USD_PER_MILLION[model];
  if (audioRates) {
    // Text counts here must already exclude the audio tokens.
    if (!hasValue(dimensions, 'input_text_tokens') || !hasValue(dimensions, 'output_text_tokens')) {
      return { dimensions, billingStatus: 'unknown', pricingVersion: AUDIO_CHAT_PRICING_VERSION, costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null };
    }
    const estimatedCostUsd = (
      (options.audioInputTokens ?? 0) * audioRates.audioIn +
      (options.audioOutputTokens ?? 0) * audioRates.audioOut +
      (dimensions.input_text_tokens ?? 0) * audioRates.textIn +
      (dimensions.output_text_tokens ?? 0) * audioRates.textOut
    ) / 1_000_000;
    return { dimensions, billingStatus: 'known', pricingVersion: AUDIO_CHAT_PRICING_VERSION, costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd };
  }

  const pricingVersion = model === 'gpt-image-2.5-flare'
    ? 'openai-2026-09-08'
    : model === 'gpt-6.1-sol'
    ? 'openai-2026-09-29'
    : model === 'gpt-6-sol' || model === 'gpt-6-luna'
    ? 'openai-2026-09-28'
    : LEGACY_PRICING_VERSION;
  const hasDimensions = Object.keys(dimensions).length > 0;
  if (model === 'gpt-4o-mini-transcribe') {
    const hasBillableDimension = hasValue(dimensions, 'audio_seconds') ||
      hasValue(dimensions, 'input_text_tokens') || hasValue(dimensions, 'output_text_tokens');
    if (!hasBillableDimension) {
      return { dimensions, billingStatus: hasDimensions ? 'known' : 'unknown', pricingVersion, costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null };
    }
    const estimatedCostUsd =
      (dimensions.audio_seconds ?? 0) * TRANSCRIBE_USD_PER_AUDIO_SECOND +
      (dimensions.input_text_tokens ?? 0) * TRANSCRIBE_INPUT_TEXT_USD_PER_MILLION / 1_000_000 +
      (dimensions.output_text_tokens ?? 0) * TRANSCRIBE_OUTPUT_TEXT_USD_PER_MILLION / 1_000_000;
    return {
      dimensions,
      billingStatus: 'known',
      pricingVersion,
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
    return { dimensions, billingStatus: hasDimensions ? 'known' : 'unknown', pricingVersion: rates ? pricingVersion : null, costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null };
  }

  // A price is complete only when every billable dimension for this model's
  // response shape is known. Missing image dimensions are zero for chat; the
  // inverse is not true for image generation, whose usage must be itemized.
  const isImage = model === 'gpt-image-2.5-flare' || model === 'gpt-image-2' || model === 'gpt-image-1.5';
  const required = isImage
    ? ['input_text_tokens', 'input_image_tokens', 'cached_input_tokens', 'output_text_tokens', 'output_image_tokens'] as const
    : ['input_text_tokens', 'output_text_tokens'] as const;
  if (required.some((key) => !hasValue(dimensions, key))) {
    return { dimensions, billingStatus: 'known', pricingVersion, costBasis: 'provider_usage', costIsComplete: false, estimatedCostUsd: null };
  }

  // Aggregate cached tokens do not identify text versus image cache pricing.
  if (model === 'gpt-image-2.5-flare' && (dimensions.cached_input_tokens ?? 0) > 0) {
    return { dimensions, billingStatus: 'known', pricingVersion, costBasis: 'provider_usage', costIsComplete: false, estimatedCostUsd: null };
  }

  const cost = (
    (dimensions.input_text_tokens ?? 0) * rates.inputText +
    (dimensions.input_image_tokens ?? 0) * rates.inputImage +
    (dimensions.cached_input_tokens ?? 0) * rates.cachedInput +
    (dimensions.output_text_tokens ?? 0) * rates.outputText +
    (dimensions.output_image_tokens ?? 0) * rates.outputImage
  ) / 1_000_000;
  return { dimensions, billingStatus: 'known', pricingVersion, costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd: cost };
}
