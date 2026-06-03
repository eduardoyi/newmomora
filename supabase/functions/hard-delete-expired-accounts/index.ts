import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { deleteObject, listObjectKeys } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface HardDeleteResponse {
  success: true;
  deletedCount: number;
}

export async function handleHardDeleteExpiredAccounts(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  if (!validateCronSecret(req)) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { data: profiles, error } = await supabase
    .from('user_profiles')
    .select('id')
    .not('scheduled_hard_delete_at', 'is', null)
    .lte('scheduled_hard_delete_at', now);

  if (error) {
    console.error('hard-delete-expired-accounts lookup failed', error.message);
    return errorResponse('Failed to load expired accounts', 500, 'internal_error');
  }

  let deletedCount = 0;

  for (const profile of profiles ?? []) {
    const userId = profile.id;

    try {
      const keys = await listObjectKeys(`${userId}/`);
      await Promise.all(keys.map((key) => deleteObject(key)));
    } catch (storageError) {
      console.error(
        'hard-delete-expired-accounts storage cleanup failed',
        userId,
        storageError instanceof Error ? storageError.message : 'unknown',
      );
    }

    await supabase.from('memories').delete().eq('user_id', userId);
    await supabase.from('family_members').delete().eq('user_id', userId);
    await supabase.from('user_profiles').delete().eq('id', userId);

    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);

    if (authDeleteError) {
      console.error('hard-delete-expired-accounts auth delete failed', authDeleteError.message);
      continue;
    }

    deletedCount += 1;
  }

  const response: HardDeleteResponse = {
    success: true,
    deletedCount,
  };

  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve(handleHardDeleteExpiredAccounts);
}
