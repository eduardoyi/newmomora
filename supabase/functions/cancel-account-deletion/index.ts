import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient, createUserClient } from '../_shared/supabase-admin.ts';

export interface CancelAccountDeletionResponse {
  success: true;
}

export async function handleCancelAccountDeletion(req: Request): Promise<Response> {
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

  const { error } = await supabase
    .from('user_profiles')
    .update({
      deleted_at: null,
      scheduled_hard_delete_at: null,
    })
    .eq('id', user.id);

  if (error) {
    console.error('cancel-account-deletion failed', error.message);
    return errorResponse('Failed to cancel account deletion', 500, 'internal_error');
  }

  // Restore any families this user owns and soft-deleted via
  // delete-user-account. Service-role client is simplest here and is
  // explicitly allowed by `enforce_families_restricted_columns` (it runs
  // without a user JWT, so `auth.uid()` is null). Best-effort: the user's
  // own account is already un-scheduled above, so a family-restore hiccup
  // is logged rather than surfaced as a request failure.
  const { error: familiesError } = await createServiceClient()
    .from('families')
    .update({ deleted_at: null })
    .eq('owner_id', user.id);

  if (familiesError) {
    console.error('cancel-account-deletion family restore failed', familiesError.message);
  }

  const response: CancelAccountDeletionResponse = { success: true };
  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve(handleCancelAccountDeletion);
}
