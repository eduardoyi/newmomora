import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createUserClient } from '../_shared/supabase-admin.ts';

export interface DeleteUserAccountResponse {
  success: true;
  scheduledHardDeleteAt: string;
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

  const response: DeleteUserAccountResponse = {
    success: true,
    scheduledHardDeleteAt,
  };

  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve(handleDeleteUserAccount);
}
