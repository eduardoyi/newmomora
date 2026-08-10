import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

interface DigestClaim { family_id: string; actor_id: string; claim_token: string; }

export interface SendGalleryImportDigestsDependencies {
  createServiceClient: typeof createServiceClient;
  sendExpoPushNotification: typeof sendExpoPushNotification;
  validateCronSecret: typeof validateCronSecret;
}

const DEFAULT_DEPENDENCIES: SendGalleryImportDigestsDependencies = {
  createServiceClient,
  sendExpoPushNotification,
  validateCronSecret,
};

/**
 * One privacy-preserving family digest after the DB's 30 minute quiet window.
 * It deliberately contains no memory/candidate IDs or counts; the client
 * opens the ordinary timeline under the recipient's own authorization.
 */
export async function handleSendGalleryImportDigests(
  req: Request,
  overrides: Partial<SendGalleryImportDigestsDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!dependencies.validateCronSecret(req)) return errorResponse('Unauthorized', 401, 'unauthorized');
  const client = dependencies.createServiceClient();
  const { data: claims, error: claimError } = await client.rpc('claim_gallery_import_digests', { p_limit: 50 });
  if (claimError) {
    console.error('send-gallery-import-digests claim failed', claimError.code ?? 'unknown');
    return errorResponse('Unable to claim gallery digest', 500, 'internal_error');
  }
  let sent = 0;
  for (const claim of (claims ?? []) as DigestClaim[]) {
    const [{ data: memberships, error: membershipError }, { data: family }] = await Promise.all([
      client.from('family_memberships').select('user_id').eq('family_id', claim.family_id).neq('user_id', claim.actor_id),
      client.from('families').select('name').eq('id', claim.family_id).maybeSingle(),
    ]);
    if (membershipError) {
      console.error('send-gallery-import-digests memberships failed', claim.family_id);
      continue;
    }
    const recipientIds = (memberships ?? []).map((membership) => membership.user_id);
    if (recipientIds.length === 0) {
      await client.rpc('finish_gallery_import_digest', { p_family_id: claim.family_id, p_actor_id: claim.actor_id, p_claim_token: claim.claim_token, p_sent: true });
      continue;
    }
    const [{ data: profiles, error: profilesError }, { data: blocks, error: blocksError }] = await Promise.all([
      client.from('user_profiles').select('id, expo_push_token, notify_new_memories').in('id', recipientIds),
      client.from('blocked_family_accounts').select('blocker_user_id').eq('family_id', claim.family_id).eq('blocked_user_id', claim.actor_id).in('blocker_user_id', recipientIds),
    ]);
    if (profilesError || blocksError) {
      console.error('send-gallery-import-digests recipient lookup failed', claim.family_id);
      continue;
    }
    const blocked = new Set((blocks ?? []).map((block) => block.blocker_user_id));
    const deliveries = (profiles ?? []).filter((profile) => profile.notify_new_memories && profile.expo_push_token && !blocked.has(profile.id));
    const results = await Promise.allSettled(deliveries.map((profile) => dependencies.sendExpoPushNotification(
      profile.expo_push_token as string,
      family?.name || 'Momora',
      'New family memories are ready to revisit.',
      { route: 'timeline', familyId: claim.family_id },
    )));
    // The outbox is family-level, not per-recipient. Once any provider call
    // has been attempted, releasing the claim would re-send to recipients
    // who already received this digest. Finalize the batch exactly once even
    // if Expo rejected/failed a recipient; only pre-delivery lookup failures
    // above remain retryable. No count, recipient, or provider text is logged.
    const hasDeliveryFailure = results.some((result) => result.status === 'rejected' || result.value === false);
    if (hasDeliveryFailure) console.error('send-gallery-import-digests push delivery incomplete', claim.family_id);
    const { error: finishError } = await client.rpc('finish_gallery_import_digest', {
      p_family_id: claim.family_id, p_actor_id: claim.actor_id, p_claim_token: claim.claim_token, p_sent: true,
    });
    if (finishError) {
      console.error('send-gallery-import-digests finish failed', claim.family_id);
      continue;
    }
    sent += 1;
  }
  return jsonResponse({ success: true, sent });
}

if (import.meta.main) Deno.serve((req) => handleSendGalleryImportDigests(req));
