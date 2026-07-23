import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface DeleteUserAccountResponse {
  success: true;
  scheduledHardDeleteAt: string;
}

const OWNER_DELETED_PUSH_BODY =
  "This family journal's owner deleted their account. The journal will be removed in 15 days unless they restore it.";

/**
 * The scheduling RPC atomically soft-deletes the owner and every currently
 * active owned family. This function only sends heads-up pushes for the
 * *exact* scheduling operation token. It must never perform the status write
 * itself: a cancellation followed by a second schedule could otherwise
 * notify or mutate families from the wrong operation.
 */
export async function softDeleteOwnedFamiliesAndNotify(
  serviceClient: ReturnType<typeof createServiceClient>,
  ownerId: string,
  operationToken: string,
): Promise<void> {
  const { data: ownedFamilies, error: ownedFamiliesError } = await serviceClient
    .from('families')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('account_deletion_token', operationToken);

  if (ownedFamiliesError) {
    console.error('delete-user-account owned-families lookup failed', ownedFamiliesError.message);
    return;
  }

  for (const family of ownedFamilies ?? []) {
    try {
      const { data: memberships, error: membershipsError } = await serviceClient
        .from('family_memberships')
        .select('user_id')
        .eq('family_id', family.id)
        .neq('user_id', ownerId);

      if (membershipsError) {
        console.error(
          'delete-user-account member lookup failed',
          family.id,
          membershipsError.message,
        );
        continue;
      }

      const memberIds = (memberships ?? []).map((row) => row.user_id);
      if (memberIds.length === 0) {
        continue;
      }

      const { data: profiles, error: profilesError } = await serviceClient
        .from('user_profiles')
        .select('id, expo_push_token')
        .in('id', memberIds);

      if (profilesError) {
        console.error(
          'delete-user-account member profile lookup failed',
          family.id,
          profilesError.message,
        );
        continue;
      }

      await Promise.all(
        (profiles ?? [])
          .filter((profile) => Boolean(profile.expo_push_token))
          .map((profile) =>
            sendExpoPushNotification(
              profile.expo_push_token as string,
              'Momora',
              OWNER_DELETED_PUSH_BODY,
            ).catch((pushError) => {
              console.error(
                'delete-user-account push failed',
                family.id,
                profile.id,
                pushError instanceof Error ? pushError.message : 'unknown',
              );
              return false;
            }),
          ),
      );
    } catch (notifyError) {
      console.error(
        'delete-user-account family notify failed',
        family.id,
        notifyError instanceof Error ? notifyError.message : 'unknown',
      );
    }
  }
}

export async function handleDeleteUserAccount(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const serviceClient = createServiceClient();
  const requestedScheduledHardDeleteAt = new Date(
    Date.now() + 15 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: operationToken, error } = await serviceClient.rpc('schedule_account_deletion', {
    p_owner_id: user.id,
    p_operation_token: crypto.randomUUID(),
    p_scheduled_hard_delete_at: requestedScheduledHardDeleteAt,
  });

  if (error) {
    console.error('delete-user-account failed', error.message);
    if (error.code === '55000' || error.message === 'Hard account deletion is in progress') {
      return errorResponse('Account deletion is already in progress', 409, 'account_deletion_in_progress');
    }
    return errorResponse('Failed to schedule account deletion', 500, 'internal_error');
  }

  if (!operationToken) {
    return errorResponse('Failed to schedule account deletion', 500, 'internal_error');
  }

  const { data: profile, error: profileError } = await serviceClient
    .from('user_profiles')
    .select('scheduled_hard_delete_at')
    .eq('id', user.id)
    .single();
  if (profileError || !profile?.scheduled_hard_delete_at) {
    console.error('delete-user-account scheduled profile lookup failed', user.id);
    return errorResponse('Failed to schedule account deletion', 500, 'internal_error');
  }

  await softDeleteOwnedFamiliesAndNotify(serviceClient, user.id, operationToken);

  const response: DeleteUserAccountResponse = {
    success: true,
    scheduledHardDeleteAt: profile.scheduled_hard_delete_at,
  };

  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve(handleDeleteUserAccount);
}
