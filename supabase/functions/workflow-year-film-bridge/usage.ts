/**
 * AI usage ledger write shared by the film (`record_usage`) and holiday card
 * (`card_record_usage`) operations: the same normalisation + pricing, only the
 * allowed operation names and the family differ. `ai_call_id` is derived by
 * the Worker (uuidV5(attemptId + ':' + key)), so a replayed step records once.
 */
import { normalizeOpenAiUsage, openAiAudioTokens, priceOpenAiUsage } from '../_shared/ai-pricing.ts';
import type { Client } from './rows.ts';

export function isValidUsageBody(body: Record<string, unknown>, operations: ReadonlySet<string>): boolean {
  return typeof body.aiCallId === 'string' && /^[0-9a-f-]{36}$/i.test(body.aiCallId) &&
    typeof body.usageOperation === 'string' && operations.has(body.usageOperation) &&
    typeof body.model === 'string' && body.model.length <= 64 && typeof body.success === 'boolean';
}

export async function recordAiUsage(
  supabase: Client,
  familyId: string,
  actorUserId: string | null,
  body: Record<string, unknown>,
): Promise<void> {
  const dimensions = normalizeOpenAiUsage(body.usage, typeof body.audioSeconds === 'number' ? body.audioSeconds : undefined);
  // gpt-audio: prompt/completion counts include the audio tokens,
  // which are priced separately.
  const audio = openAiAudioTokens(body.usage);
  if (audio.input > 0 && dimensions.input_text_tokens !== undefined) {
    dimensions.input_text_tokens = Math.max(0, dimensions.input_text_tokens - audio.input);
  }
  if (audio.output > 0 && dimensions.output_text_tokens !== undefined) {
    dimensions.output_text_tokens = Math.max(0, dimensions.output_text_tokens - audio.output);
  }
  const priced = priceOpenAiUsage(body.model as string, dimensions, { audioInputTokens: audio.input, audioOutputTokens: audio.output });
  const { error } = await supabase.rpc('record_ai_usage_event_detailed', {
    p_ai_call_id: body.aiCallId, p_usage_request_id: null, p_family_id: familyId,
    p_actor_user_id: actorUserId, p_operation: body.usageOperation, p_model: body.model,
    p_success: body.success, p_provider_usage: priced.dimensions, p_estimated_cost_usd: priced.estimatedCostUsd,
    p_cost_basis: priced.costBasis, p_billing_status: priced.billingStatus, p_cost_is_complete: priced.costIsComplete,
    p_pricing_version: priced.pricingVersion,
  });
  if (error) throw error;
}
