import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import {
  getCallerFamilyRole,
  isManagerRole,
  resolveStorageKeyFamilyIds,
} from '../_shared/family-access.ts';
import { deleteObject } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface DeleteStorageObjectRequest {
  objectKey: string;
}

export interface DeleteStorageObjectResponse {
  success: true;
}

export async function handleDeleteStorageObject(req: Request): Promise<Response> {
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

  let body: DeleteStorageObjectRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { objectKey } = body;

  if (!objectKey || typeof objectKey !== 'string') {
    return errorResponse('objectKey is required', 400, 'validation_error');
  }

  const serviceClient = createServiceClient();
  const [resolved] = await resolveStorageKeyFamilyIds(serviceClient, [objectKey]);

  if (!resolved.familyId) {
    return errorResponse('Invalid object key', 400, 'validation_error');
  }

  const role = await getCallerFamilyRole(serviceClient, resolved.familyId, user.id);

  if (!isManagerRole(role)) {
    return errorResponse('Not authorized for this object', 403, 'forbidden');
  }

  try {
    await deleteObject(objectKey);

    const response: DeleteStorageObjectResponse = {
      success: true,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error(
      'delete-storage-object failed',
      error instanceof Error ? error.message : 'unknown',
    );
    return errorResponse('Failed to delete storage object', 500, 'internal_error');
  }
}

if (import.meta.main) {
  Deno.serve(handleDeleteStorageObject);
}
