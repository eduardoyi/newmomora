import type { ResolvedSharePayload } from 'expo-sharing';

import type { MediaAttachment } from '@/components/memory-media-picker';
import { validateMediaFileCheap, validateVideoDuration } from '@/utils/media-validation';

export const MAX_SHARED_MEDIA_ATTACHMENTS = 10;
const MAX_CONCURRENT_SHARED_MEDIA_PREPARATIONS = 3;
const OPTIONAL_METADATA_TIMEOUT_MS = 750;
export const DUPLICATE_SHARED_MEDIA_URI_ERROR =
  'Momora could not distinguish same-named shared files. Please attach them from inside Momora instead.';
export const UNREADABLE_SHARED_MEDIA_COPY_ERROR =
  'Could not open the shared photos or videos. Try sharing them again.';

export interface PrepareSharedMediaDependencies {
  createId: () => string;
  getLocalFileSizeBytes: (uri: string) => Promise<number | null>;
  getVideoDurationMs: (uri: string) => Promise<number | null>;
  getImageCaptureDateIso: (uri: string) => Promise<string | null>;
  getVideoCaptureDateIso: (uri: string) => Promise<string | null>;
}

export interface PrepareSharedMediaResult {
  attachments: MediaAttachment[];
  errorMessage: string | null;
}

function isSupportedSharedPayload(
  payload: ResolvedSharePayload,
): payload is ResolvedSharePayload & { contentType: 'image' | 'video'; contentUri: string } {
  return (
    (payload.contentType === 'image' || payload.contentType === 'video') &&
    typeof payload.contentUri === 'string' &&
    payload.contentUri.length > 0
  );
}

interface SharedMediaPreparation {
  payload: ResolvedSharePayload & { contentType: 'image' | 'video'; contentUri: string };
  contentType: string;
  durationMs?: number;
  capturedAtIso?: string;
  errorMessage?: string;
}

/**
 * Optional metadata must never hold up attachment preparation. The timer is
 * intentionally per probe but measured against one caller-provided absolute
 * deadline, so worker waves do not each receive a fresh 750ms allowance.
 */
async function getOptionalCaptureDate(
  getCaptureDateIso: (uri: string) => Promise<string | null>,
  uri: string,
  deadlineAt: number,
): Promise<string | null> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return null;
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), remainingMs);
  });
  const captureDate = Promise.resolve()
    .then(() => getCaptureDateIso(uri))
    // The timeout callback can be delayed while JS is busy. Checking the
    // absolute deadline again when the native result reaches JS prevents a
    // late microtask from winning Promise.race before that overdue callback.
    .then((capturedAtIso) => (Date.now() < deadlineAt ? capturedAtIso : null))
    .catch(() => null);

  try {
    return await Promise.race([captureDate, timeout]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

export async function prepareSharedMedia(
  payloads: ResolvedSharePayload[],
  dependencies: PrepareSharedMediaDependencies,
): Promise<PrepareSharedMediaResult> {
  const optionalMetadataDeadlineAt = Date.now() + OPTIONAL_METADATA_TIMEOUT_MS;
  const mediaPayloads = payloads.filter(isSupportedSharedPayload);

  if (mediaPayloads.length === 0) {
    return {
      attachments: [],
      errorMessage: 'Momora can only attach shared photos and videos.',
    };
  }

  const selectedPayloads = mediaPayloads.slice(0, MAX_SHARED_MEDIA_ATTACHMENTS);

  // Preflight every selected payload before we start any native I/O. This
  // intentionally preserves payload order for validation precedence.
  for (const payload of selectedPayloads) {
    const contentType = payload.contentMimeType ?? payload.mimeType ?? '';
    const validationError = validateMediaFileCheap({
      contentType,
      sizeBytes: payload.contentSize,
    });

    if (validationError) {
      return { attachments: [], errorMessage: validationError };
    }
  }

  const seenContentUris = new Set<string>();
  for (const payload of selectedPayloads) {
    if (seenContentUris.has(payload.contentUri)) {
      return { attachments: [], errorMessage: DUPLICATE_SHARED_MEDIA_URI_ERROR };
    }
    seenContentUris.add(payload.contentUri);
  }

  const preparations: (SharedMediaPreparation | undefined)[] = new Array(selectedPayloads.length);
  let nextPayloadIndex = 0;
  let hasDefinitiveValidationFailure = false;

  const preparePayload = async (
    payload: ResolvedSharePayload & { contentType: 'image' | 'video'; contentUri: string },
  ): Promise<SharedMediaPreparation> => {
    const contentType = payload.contentMimeType ?? payload.mimeType ?? '';
    let copiedSizeBytes: number | null;
    try {
      copiedSizeBytes = await dependencies.getLocalFileSizeBytes(payload.contentUri);
    } catch {
      return { payload, contentType, errorMessage: UNREADABLE_SHARED_MEDIA_COPY_ERROR };
    }

    if (copiedSizeBytes === null || copiedSizeBytes !== payload.contentSize) {
      return { payload, contentType, errorMessage: UNREADABLE_SHARED_MEDIA_COPY_ERROR };
    }

    const getCaptureDateIso = payload.contentType === 'image'
      ? dependencies.getImageCaptureDateIso
      : dependencies.getVideoCaptureDateIso;
    const capturedAtIsoPromise = getOptionalCaptureDate(
      getCaptureDateIso,
      payload.contentUri,
      optionalMetadataDeadlineAt,
    );

    if (payload.contentType === 'image') {
      const capturedAtIso = await capturedAtIsoPromise;
      return {
        payload,
        contentType,
        ...(capturedAtIso ? { capturedAtIso } : {}),
      };
    }

    // Duration remains required. Start it alongside optional metadata, but do
    // not weaken it with the metadata deadline.
    const durationMs = await dependencies.getVideoDurationMs(payload.contentUri);
    const capturedAtIso = await capturedAtIsoPromise;
    const durationValidationError = validateVideoDuration(durationMs);

    if (durationValidationError) {
      return { payload, contentType, errorMessage: durationValidationError };
    }

    return {
      payload,
      contentType,
      durationMs: durationMs ?? undefined,
      ...(capturedAtIso ? { capturedAtIso } : {}),
    };
  };

  const runWorker = async () => {
    while (!hasDefinitiveValidationFailure && nextPayloadIndex < selectedPayloads.length) {
      const payloadIndex = nextPayloadIndex;
      nextPayloadIndex += 1;
      const preparation = await preparePayload(selectedPayloads[payloadIndex]);
      preparations[payloadIndex] = preparation;

      if (preparation.errorMessage) {
        hasDefinitiveValidationFailure = true;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_SHARED_MEDIA_PREPARATIONS, selectedPayloads.length) },
      () => runWorker(),
    ),
  );

  // Results may complete out of order. Inspect them in payload order so the
  // observed error remains stable and all-or-nothing.
  for (const preparation of preparations) {
    if (preparation?.errorMessage) {
      return { attachments: [], errorMessage: preparation.errorMessage };
    }
  }

  const attachments = preparations.map((preparation): MediaAttachment => {
    if (!preparation) {
      // A worker can only leave a gap after a known validation failure, which
      // was returned above. Keep this guard fail-closed if that invariant ever
      // changes.
      throw new Error('Shared media preparation ended before all payloads completed.');
    }

    return {
      id: dependencies.createId(),
      uri: preparation.payload.contentUri,
      contentType: preparation.contentType,
      durationMs: preparation.durationMs ?? undefined,
      sizeBytes: preparation.payload.contentSize as number,
      ...(preparation.capturedAtIso ? { capturedAtIso: preparation.capturedAtIso } : {}),
    };
  });

  return {
    attachments,
    errorMessage: mediaPayloads.length > MAX_SHARED_MEDIA_ATTACHMENTS
      ? 'Momora attached the first 10 items. A memory can include up to 10 photos or videos.'
      : null,
  };
}
