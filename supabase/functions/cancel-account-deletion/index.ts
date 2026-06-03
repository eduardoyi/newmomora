import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createUserClient } from '../_shared/supabase-admin.ts';

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

  const response: CancelAccountDeletionResponse = { success: true };
  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve(handleCancelAccountDeletion);
}
