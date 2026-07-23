const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class UploadLeaseError extends Error {
  constructor(
    public readonly code: 'UPLOAD_NOT_AUTHORIZED' | 'UPLOAD_OUTCOME_AMBIGUOUS',
    public readonly hasAmbiguousOutput: boolean,
  ) {
    super(code);
  }
}

interface UploadAuthorization {
  authorized: boolean;
  uploadToken: string | null;
  existingLease: boolean;
}

interface UploadCompletion {
  completed: boolean;
}

interface UploadWithLeaseOptions {
  authorize: () => Promise<UploadAuthorization>;
  existingObject: () => Promise<boolean>;
  put: () => Promise<void>;
  recordComplete: (uploadToken: string) => Promise<UploadCompletion>;
  putAttempts?: number;
}

type ExistingUploadWithLeaseOptions = Omit<UploadWithLeaseOptions, 'existingObject' | 'put' | 'putAttempts'>;

async function authorizeUpload(authorize: () => Promise<UploadAuthorization>): Promise<UploadAuthorization & { uploadToken: string }> {
  const authorization = await authorize();
  if (!authorization.authorized ||
    !authorization.uploadToken ||
    !UUID_PATTERN.test(authorization.uploadToken)) {
    throw new UploadLeaseError('UPLOAD_NOT_AUTHORIZED', false);
  }
  return authorization as UploadAuthorization & { uploadToken: string };
}

async function completeUpload(
  recordComplete: (uploadToken: string) => Promise<UploadCompletion>,
  uploadToken: string,
): Promise<void> {
  try {
    const completion = await recordComplete(uploadToken);
    if (!completion.completed) {
      throw new UploadLeaseError('UPLOAD_OUTCOME_AMBIGUOUS', true);
    }
  } catch {
    throw new UploadLeaseError('UPLOAD_OUTCOME_AMBIGUOUS', true);
  }
}

/**
 * Fences entity deletion/recovery around the external R2 PUT. A thrown PUT or
 * completion response is always treated as ambiguous: the object may exist,
 * so outer failure handling must leave the deterministic key for recovery.
 */
export async function uploadWithLease(options: UploadWithLeaseOptions): Promise<void> {
  const authorization = await authorizeUpload(options.authorize);

  if (authorization.existingLease) {
    try {
      if (await options.existingObject()) {
        await completeUpload(options.recordComplete, authorization.uploadToken);
        return;
      }
    } catch {
      throw new UploadLeaseError('UPLOAD_OUTCOME_AMBIGUOUS', true);
    }
    // Another request may still be writing this deterministic key. Never
    // overwrite it with a distinct provider result while its lease is fresh.
    throw new UploadLeaseError('UPLOAD_OUTCOME_AMBIGUOUS', true);
  }

  const putAttempts = options.putAttempts ?? 3;
  if (!Number.isInteger(putAttempts) || putAttempts < 1) {
    throw new UploadLeaseError('UPLOAD_NOT_AUTHORIZED', false);
  }
  let wasPut = false;
  for (let attempt = 0; attempt < putAttempts; attempt += 1) {
    try {
      // Same-key/same-byte PUTs are idempotent. Keep all bounded retries under
      // this exact lease and never re-enter the paid provider.
      await options.put();
      wasPut = true;
      break;
    } catch {
      if (attempt === putAttempts - 1) {
        throw new UploadLeaseError('UPLOAD_OUTCOME_AMBIGUOUS', true);
      }
    }
  }
  if (!wasPut) throw new UploadLeaseError('UPLOAD_OUTCOME_AMBIGUOUS', true);

  await completeUpload(options.recordComplete, authorization.uploadToken);
}

/**
 * HEAD recovery must participate in the same fence as a new PUT. This either
 * reuses a fresh token left by an ambiguous PUT or obtains a no-op lease for
 * an already-cleared object, then records that exact token before publish.
 */
export async function confirmExistingUploadWithLease(
  options: ExistingUploadWithLeaseOptions,
): Promise<void> {
  const authorization = await authorizeUpload(options.authorize);
  await completeUpload(options.recordComplete, authorization.uploadToken);
}

export function hasAmbiguousUploadOutput(error: unknown): boolean {
  if (error instanceof UploadLeaseError) return error.hasAmbiguousOutput;
  // Workflow step failures may be serialized before propagating back into
  // run(). Recognize only the exact private code; broad substring matching
  // could suppress legitimate terminal failures.
  return error !== null && typeof error === 'object' &&
    'message' in error && error.message === 'UPLOAD_OUTCOME_AMBIGUOUS';
}
