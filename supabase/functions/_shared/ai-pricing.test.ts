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

Deno.test('prices Flare from measured usage without guessing cached modality', () => {
  const dimensions = { input_text_tokens: 10, input_image_tokens: 20, cached_input_tokens: 0, output_text_tokens: 0, output_image_tokens: 5 };
  assertEquals(priceOpenAiUsage('gpt-image-2.5-flare', dimensions).estimatedCostUsd, 0.00036);
  assertEquals(priceOpenAiUsage('gpt-image-2.5-flare', { ...dimensions, cached_input_tokens: 3 }).costIsComplete, false);
});

Deno.test('gpt-6 chat usage is priced under its own pricing version (Year Film)', () => {
  const sol = priceOpenAiUsage('gpt-6-sol', { input_text_tokens: 10_000, output_text_tokens: 1_000 });
  assertEquals(sol.pricingVersion, 'openai-2026-09-28');
  assertEquals(sol.costIsComplete, true);
  assertEquals(Math.round((sol.estimatedCostUsd ?? 0) * 1e6), 30_000); // 10k*2 + 1k*10 per million = $0.03
  const luna = priceOpenAiUsage('gpt-6-luna', { input_text_tokens: 10_000, output_text_tokens: 1_000 });
  assertEquals(Math.round((luna.estimatedCostUsd ?? 0) * 1e6), 1_500);
  assertEquals(priceOpenAiUsage('gpt-audio-1.5', { audio_seconds: 6 }).costBasis, 'unpriced'); // no token counts
});

Deno.test('gpt-6.1-sol (holiday card film) is priced: $2 in, $0.10 cached, $10 out, own pricing version', () => {
  const sol = priceOpenAiUsage('gpt-6.1-sol', { input_text_tokens: 10_000, output_text_tokens: 1_000 });
  assertEquals(sol.pricingVersion, 'openai-2026-09-29');
  assertEquals(sol.costIsComplete, true);
  assertEquals(Math.round((sol.estimatedCostUsd ?? 0) * 1e6), 30_000);
  const cached = priceOpenAiUsage('gpt-6.1-sol', { input_text_tokens: 5_000, cached_input_tokens: 5_000, output_text_tokens: 0 });
  assertEquals(Math.round((cached.estimatedCostUsd ?? 0) * 1e6), 10_500); // 5k*2 + 5k*0.10 per million
  // gpt-6-sol keeps its rates and version.
  assertEquals(priceOpenAiUsage('gpt-6-sol', { input_text_tokens: 10_000, output_text_tokens: 1_000 }).pricingVersion, 'openai-2026-09-28');
});

Deno.test('gpt-audio voice checks price audio and text tokens separately', async () => {
  const { openAiAudioTokens } = await import('./ai-pricing.ts');
  const usage = { prompt_tokens: 260, completion_tokens: 40, prompt_tokens_details: { audio_tokens: 60 } };
  const audio = openAiAudioTokens(usage);
  assertEquals(audio, { input: 60, output: 0 });
  const priced = priceOpenAiUsage('gpt-audio-1.5', { input_text_tokens: 200, output_text_tokens: 40, audio_seconds: 6 }, {
    audioInputTokens: audio.input, audioOutputTokens: audio.output,
  });
  // 60×$32 + 200×$2.5 + 40×$10 per million = $0.00282
  assertEquals(Math.round((priced.estimatedCostUsd ?? 0) * 1e6), 2820);
  assertEquals(priced.costIsComplete, true);
  assertEquals(priced.pricingVersion, 'openai-2026-09-29');
  const mini = priceOpenAiUsage('gpt-audio-mini', { input_text_tokens: 200, output_text_tokens: 40 }, { audioInputTokens: 60 });
  assertEquals(Math.round((mini.estimatedCostUsd ?? 0) * 1e6), 816);
});
