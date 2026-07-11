import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { createServiceClient, createUserClient } from '../_shared/supabase-admin.ts';

export interface DeleteUserAccountResponse {
  success: true;
  scheduledHardDeleteAt: string;
}

const OWNER_DELETED_PUSH_BODY =
  "This family journal's owner deleted their account. The journal will be removed in 15 days unless they restore it.";

/**
 * Soft-deletes every family `ownerId` owns (the DB trigger allows this from
 * the service-role client, which runs without a user JWT -- see
 * `enforce_families_restricted_columns`) and sends a heads-up push to each
 * other member with a push token. Best-effort: failures are logged, not
 * thrown, so a family/push hiccup never blocks the account-deletion
 * response once the user_profiles row (source of truth for the 15-day
 * grace window) is already updated.
 */
export async function softDeleteOwnedFamiliesAndNotify(
  serviceClient: ReturnType<typeof createServiceClient>,
  ownerId: string,
): Promise<void> {
  const { data: ownedFamilies, error: ownedFamiliesError } = await serviceClient
    .from('families')
    .select('id')
    .eq('owner_id', ownerId)
    .is('deleted_at', null);

  if (ownedFamiliesError) {
    console.error('delete-user-account owned-families lookup failed', ownedFamiliesError.message);
    return;
  }

  for (const family of ownedFamilies ?? []) {
    const { error: softDeleteError } = await serviceClient
      .from('families')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', family.id);

    if (softDeleteError) {
      console.error(
        'delete-user-account family soft-delete failed',
        family.id,
        softDeleteError.message,
      );
      continue;
    }

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

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = createUserClient(authHeader);
  const scheduledHardDeleteAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('user_profiles')
    .update({
      deleted_at: new Date().toISOString(),
      scheduled_hard_delete_at: scheduledHardDeleteAt,
    })
    .eq('id', user.id);

  if (error) {
    console.error('delete-user-account failed', error.message);
    return errorResponse('Failed to schedule account deletion', 500, 'internal_error');
  }

  await softDeleteOwnedFamiliesAndNotify(createServiceClient(), user.id);

  const response: DeleteUserAccountResponse = {
    success: true,
    scheduledHardDeleteAt,
  };

  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve(handleDeleteUserAccount);
}
