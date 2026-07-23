import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

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

  const { data: cancelled, error } = await createServiceClient().rpc('cancel_account_deletion', {
    p_owner_id: user.id,
  });

  if (error) {
    console.error('cancel-account-deletion failed', error.message);
    return errorResponse('Failed to cancel account deletion', 500, 'internal_error');
  }
  if (!cancelled) {
    return errorResponse('Account deletion is already in progress', 409, 'account_deletion_in_progress');
  }

  const response: CancelAccountDeletionResponse = { success: true };
  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve(handleCancelAccountDeletion);
}
