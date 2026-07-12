import type { ResolvedSharePayload } from 'expo-sharing';

import type { MediaAttachment } from '@/components/memory-media-picker';
import { validateMediaFile } from '@/utils/media-validation';

export const MAX_SHARED_MEDIA_ATTACHMENTS = 10;

interface PrepareSharedMediaDependencies {
  createId: () => string;
  getVideoDurationMs: (uri: string) => Promise<number | null>;
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

export async function prepareSharedMedia(
  payloads: ResolvedSharePayload[],
  dependencies: PrepareSharedMediaDependencies,
): Promise<PrepareSharedMediaResult> {
  const mediaPayloads = payloads.filter(isSupportedSharedPayload);

  if (mediaPayloads.length === 0) {
    return {
      attachments: [],
      errorMessage: 'Momora can only attach shared photos and videos.',
    };
  }

  const attachments: MediaAttachment[] = [];
  for (const payload of mediaPayloads.slice(0, MAX_SHARED_MEDIA_ATTACHMENTS)) {
    const contentType = payload.contentMimeType ?? payload.mimeType ?? '';
    const durationMs = payload.contentType === 'video'
      ? await dependencies.getVideoDurationMs(payload.contentUri)
      : undefined;
    const validationError = validateMediaFile({
      contentType,
      durationMs,
      sizeBytes: payload.contentSize,
    });

    if (validationError) {
      return { attachments: [], errorMessage: validationError };
    }

    attachments.push({
      id: dependencies.createId(),
      uri: payload.contentUri,
      contentType,
      durationMs: durationMs ?? undefined,
      sizeBytes: payload.contentSize as number,
    });
  }

  return {
    attachments,
    errorMessage: mediaPayloads.length > MAX_SHARED_MEDIA_ATTACHMENTS
      ? 'Momora attached the first 10 items. A memory can include up to 10 photos or videos.'
      : null,
  };
}
