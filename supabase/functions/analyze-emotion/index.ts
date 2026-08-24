import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole } from '../_shared/family-access.ts';
import { stripUrls } from '../_shared/link-preview.ts';
import { isAllowedImageMediaContentType, isVideoMediaContentType } from '../_shared/media-emotion.ts';
import {
  fetchTaggedMembers,
  runMemoryAnalysis,
  updateMemoryAnalysisIfSnapshotMatches,
  upsertMemoryMilestones,
  type MediaAssetForAnalysis,
} from '../_shared/analyze-memory-core.ts';
import { createServiceClient, createUserClient } from '../_shared/supabase-admin.ts';
import { checkBillingFamilyWrite } from '../_shared/billing.ts';

export interface AnalyzeEmotionRequest {
  memoryId: string;
}

/**
 * `analyze-emotion`'s original response contract, preserved verbatim for old
 * app versions. `analyze-memory` (the alias endpoint, same handler) returns
 * the same shape.
 */
export interface AnalyzeEmotionResponse {
  emotion: string;
  colorPalette: string;
  skipped?: boolean;
}

/**
 * A strict superset of `AnalyzeEmotionResponse` -- new fields are additive
 * only (docs/plans/memory-book.md §5 Stage A, TECH_SPEC §4.2). Old clients
 * that only read `emotion`/`colorPalette`/`skipped` are unaffected.
 */
export interface AnalyzeMemoryResponse extends AnalyzeEmotionResponse {
  topics?: string[];
  labels?: string[];
  description?: string;
}

// `fetchTaggedMembers`/`updateMemoryAnalysisIfSnapshotMatches`/
// `upsertMemoryMilestones` moved into `_shared/analyze-memory-core.ts`
// (phase 2, docs/plans/memory-book.md V1 exit backfill) so
// `supabase/scripts/backfill-memory-analysis.ts` can reuse them without
// duplicating persistence logic. Re-exported here so this module's own
// import path (`./index.ts`) stays stable for existing test imports and any
// other caller.
export { fetchTaggedMembers, updateMemoryAnalysisIfSnapshotMatches, upsertMemoryMilestones };

interface MemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_type: string;
  memory_date: string;
  media_key: string | null;
  media_content_type: string | null;
  updated_at: string;
  /** Audio memories only (docs/features/audio-memories.md). Invisible, search-only transcript. */
  audio_transcript: string | null;
}

interface MemoryMediaRow {
  object_key: string;
  content_type: string;
  position: number;
  preview_object_key: string | null;
}

const recentAnalysisByMemory = new Map<string, number>();
const ANALYSIS_COOLDOWN_MS = 5000;

function isWithinCooldown(memoryId: string): boolean {
  const lastRun = recentAnalysisByMemory.get(memoryId);
  if (!lastRun) {
    return false;
  }

  return Date.now() - lastRun < ANALYSIS_COOLDOWN_MS;
}

function markAnalysisRun(memoryId: string): void {
  recentAnalysisByMemory.set(memoryId, Date.now());
}

export interface MediaPhotoValidationError {
  status: number;
  message: string;
  code: string;
}

/**
 * `media`-type request validation. A usable candidate is any asset with a
 * `preview_object_key` (a photo preview OR a video poster frame -- both are
 * JPEGs) or any non-video image asset -- this is what lets a video WITH a
 * backfilled poster analyze like a photo (closing the "video has no emotion
 * in MVP" gap: docs/plans/memory-book.md §5 Stage A). A memory whose only
 * asset is video with no poster still hits the `video_not_supported` error
 * below, same as before.
 */
export function validateMediaPhotoMemoryRow(
  row: Pick<MemoryRow, 'memory_type' | 'media_key' | 'media_content_type'>,
  mediaAssets: MemoryMediaRow[] = [],
): MediaPhotoValidationError | null {
  if (row.memory_type !== 'media') {
    return {
      status: 400,
      message: 'Unsupported memory type for emotion analysis',
      code: 'invalid_memory_type',
    };
  }

  // No caller-prefix key assertion here: membership in the memory's family
  // (checked before this is called) is the authorization signal, and these
  // keys come from the DB row (trusted), not from client input.
  const hasUsableAsset = mediaAssets.some(
    (asset) => isAllowedImageMediaContentType(asset.content_type) || Boolean(asset.preview_object_key),
  );

  if (hasUsableAsset) {
    return null;
  }

  if (mediaAssets.length > 0 && mediaAssets.every((asset) => isVideoMediaContentType(asset.content_type))) {
    return {
      status: 400,
      message: 'Video emotion analysis is not supported',
      code: 'video_not_supported',
    };
  }

  if (!row.media_key) {
    return {
      status: 400,
      message: 'Media key is required for media memories',
      code: 'validation_error',
    };
  }

  const mediaContentType = row.media_content_type ?? '';

  if (isVideoMediaContentType(mediaContentType)) {
    return {
      status: 400,
      message: 'Video emotion analysis is not supported',
      code: 'video_not_supported',
    };
  }

  if (!isAllowedImageMediaContentType(mediaContentType)) {
    return {
      status: 400,
      message: 'Unsupported media content type',
      code: 'validation_error',
    };
  }

  return null;
}

export async function handleAnalyzeEmotion(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await getAuthenticatedNonAnonymousUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: AnalyzeEmotionRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { memoryId } = body;

  if (!memoryId || typeof memoryId !== 'string') {
    return errorResponse('memoryId is required', 400, 'validation_error');
  }

  if (isWithinCooldown(memoryId)) {
    return errorResponse('Analysis was run too recently', 429, 'rate_limited');
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = createUserClient(authHeader);
  // Analysis writes must land through the service-role client: a viewer's
  // user-client UPDATE would silently match zero rows under the manager+
  // `memories` policy (200 with no-op), leaving `isEmotionAnalyzable` true
  // and causing a permanent client retry loop. Membership (any role, below)
  // authorizes triggering analysis; the enrichment write is a system write.
  const serviceClient = createServiceClient();

  const { data: memory, error: memoryError } = await supabase
    .from('memories')
    .select(
      'id, family_id, content, memory_type, memory_date, media_key, media_content_type, audio_transcript, updated_at',
    )
    .eq('id', memoryId)
    .maybeSingle();

  if (memoryError) {
    console.error('analyze-emotion memory lookup failed', memoryError.message);
    return errorResponse('Failed to load memory', 500, 'internal_error');
  }

  if (!memory) {
    return errorResponse('Memory not found', 404, 'MEMORY_NOT_FOUND');
  }

  const callerRole = await getCallerFamilyRole(supabase, memory.family_id, user.id);
  if (!callerRole) {
    return errorResponse('Not authorized for this memory', 403, 'forbidden');
  }

  const billingResponse = await checkBillingFamilyWrite(
    serviceClient,
    memory.family_id,
    user.id,
    'emotion_analysis',
  );
  if (billingResponse) return billingResponse;

  const row = memory as MemoryRow;
  const snapshot = {
    updated_at: row.updated_at,
    content: row.content,
  };

  try {
    markAnalysisRun(memoryId);

    if (row.memory_type === 'text_illustration' || row.memory_type === 'text_only') {
      // A URL-only memory passes the raw-content check but would produce an
      // empty prompt after stripUrls -- test against the stripped content
      // so it takes the same skip path as truly-empty content.
      if (!row.content || !stripUrls(row.content).trim()) {
        return errorResponse(
          'Text content is required for text-based memories',
          400,
          'validation_error',
        );
      }
    }

    let orderedMedia: MemoryMediaRow[] = [];

    if (row.memory_type === 'media') {
      const { data: mediaRows, error: mediaError } = await supabase
        .from('memory_media')
        .select('object_key, content_type, position, preview_object_key')
        .eq('memory_id', memoryId)
        .order('position', { ascending: true });

      if (mediaError) {
        console.error('analyze-emotion media lookup failed', mediaError.message);
        return errorResponse('Failed to load media assets', 500, 'internal_error');
      }

      orderedMedia = (mediaRows ?? []) as MemoryMediaRow[];
      const mediaValidationError = validateMediaPhotoMemoryRow(row, orderedMedia);
      if (mediaValidationError) {
        return errorResponse(
          mediaValidationError.message,
          mediaValidationError.status,
          mediaValidationError.code,
        );
      }
    }

    const taggedMembers = await fetchTaggedMembers(supabase, memoryId);

    const result = await runMemoryAnalysis({
      memory: {
        id: row.id,
        content: row.content,
        memoryType: row.memory_type,
        memoryDate: row.memory_date,
        audioTranscript: row.audio_transcript,
      },
      taggedMembers,
      media: orderedMedia.map(
        (asset): MediaAssetForAnalysis => ({
          objectKey: asset.object_key,
          contentType: asset.content_type,
          position: asset.position,
          previewObjectKey: asset.preview_object_key,
        }),
      ),
    });

    if (result.skipped) {
      const response: AnalyzeMemoryResponse = { emotion: '', colorPalette: '', skipped: true };
      return jsonResponse(response);
    }

    const updated = await updateMemoryAnalysisIfSnapshotMatches(
      serviceClient,
      memoryId,
      {
        emotion: result.emotion,
        topics: result.topics,
        topicDetails: result.topicDetails,
        labels: result.labels,
        description: result.description,
      },
      snapshot,
    );

    if (updated) {
      await upsertMemoryMilestones(serviceClient, memoryId, row.family_id, result.milestones);
    }

    const response: AnalyzeMemoryResponse = {
      emotion: result.emotion,
      colorPalette: result.colorPalette,
      topics: result.topics.map((topic) => topic.id),
      labels: result.labels,
      description: result.description,
      skipped: updated ? undefined : true,
    };

    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';

    if (message === 'file_too_large') {
      return errorResponse('Media file is too large for analysis', 400, 'file_too_large');
    }

    if (message === 'unsupported_image_format') {
      return errorResponse('Image format is not supported for analysis', 400, 'unsupported_image_format');
    }

    console.error('analyze-emotion failed', message);
    return errorResponse('Emotion analysis failed', 500, 'ANALYSIS_FAILED');
  }
}

if (import.meta.main) {
  Deno.serve(handleAnalyzeEmotion);
}
