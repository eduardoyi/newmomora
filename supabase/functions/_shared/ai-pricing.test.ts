import { assertEquals } from 'jsr:@std/assert@1';
import { normalizeOpenAiUsage, priceOpenAiUsage } from './ai-pricing.ts';

Deno.test('normalizes nested image usage without retaining provider payload fields', () => {
  const dimensions = normalizeOpenAiUsage({
    input_tokens_details: { text_tokens: 12, image_tokens: 34, cached_tokens: 5, private_note: 'never persist' },
    output_tokens_details: { text_tokens: 6, image_tokens: 78, prompt: 'never persist' },
    response_text: 'never persist',
  });
  assertEquals(dimensions, {
    input_text_tokens: 12,
    input_image_tokens: 34,
    cached_input_tokens: 5,
    output_text_tokens: 6,
    output_image_tokens: 78,
  });
  const priced = priceOpenAiUsage('gpt-image-1.5', dimensions);
  assertEquals(priced.costIsComplete, true);
  assertEquals(priced.costBasis, 'provider_usage');
  assertEquals(priced.estimatedCostUsd, (12 * 5 + (34 + 5) * 8 + 6 * 10 + 78 * 32) / 1_000_000);
});

Deno.test('normalizes legacy chat usage fields and leaves incomplete cost unpriced', () => {
  const dimensions = normalizeOpenAiUsage({ prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 });
  assertEquals(dimensions, { input_text_tokens: 100, output_text_tokens: 25 });
  assertEquals(priceOpenAiUsage('gpt-4o-mini', dimensions), {
    dimensions,
    billingStatus: 'known',
    pricingVersion: 'openai-2026-07-27',
    costBasis: 'provider_usage',
    costIsComplete: true,
    estimatedCostUsd: (100 * 0.15 + 25 * 0.60) / 1_000_000,
  });
  assertEquals(priceOpenAiUsage('gpt-image-2', dimensions).costIsComplete, false);
});

Deno.test('prices transcription from reported duration and input/output text usage', () => {
  const dimensions = normalizeOpenAiUsage({ duration: 17.5, input_tokens: 120, output_tokens: 30 });
  assertEquals(dimensions, { input_text_tokens: 120, output_text_tokens: 30, audio_seconds: 17.5 });
  assertEquals(priceOpenAiUsage('gpt-4o-mini-transcribe', dimensions), {
    dimensions,
    billingStatus: 'known',
    pricingVersion: 'openai-2026-07-27',
    costBasis: 'provider_usage',
    costIsComplete: true,
    estimatedCostUsd: 17.5 * 0.003 / 60 + 120 * 1.25 / 1_000_000 + 30 * 5 / 1_000_000,
  });
});

Deno.test('records audio-only transcription fallback as incomplete request-shape estimate', () => {
  const dimensions = normalizeOpenAiUsage(undefined, 17.5);
  assertEquals(dimensions, { audio_seconds: 17.5 });
  const priced = priceOpenAiUsage('gpt-4o-mini-transcribe', dimensions, { audioDurationIsEstimate: true });
  assertEquals(priced.costIsComplete, false);
  assertEquals(priced.costBasis, 'request_shape_estimate');
  assertEquals(priced.estimatedCostUsd, 17.5 * 0.003 / 60);
});

Deno.test('leaves transcription unpriced when neither provider usage nor duration is available', () => {
  assertEquals(priceOpenAiUsage('gpt-4o-mini-transcribe', {}), {
    dimensions: {}, billingStatus: 'unknown', pricingVersion: 'openai-2026-07-27',
    costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null,
  });
});
