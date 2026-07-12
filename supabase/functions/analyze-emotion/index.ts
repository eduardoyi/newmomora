import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole } from '../_shared/family-access.ts';
import { stripUrls } from '../_shared/link-preview.ts';
import {
  isAllowedImageMediaContentType,
  isVideoMediaContentType,
  normalizeEmotionLabel,
  prepareVisionImageFromBytes,
} from '../_shared/media-emotion.ts';
import { chatJson, chatJsonWithVision } from '../_shared/openai.ts';
import {
  buildEmotionSystemPrompt,
  buildEmotionVisionUserPrompt,
  buildMediaEmotionSystemPrompt,
  EMOTION_PALETTES,
} from '../_shared/prompts.ts';
import { getObjectBytes } from '../_shared/r2.ts';
import { createServiceClient, createUserClient } from '../_shared/supabase-admin.ts';

export interface AnalyzeEmotionRequest {
  memoryId: string;
}

export interface AnalyzeEmotionResponse {
  emotion: string;
  colorPalette: string;
  skipped?: boolean;
}

interface MemoryRow {
  id: string;
  content: string | null;
  memory_type: string;
  media_key: string | null;
  media_content_type: string | null;
  updated_at: string;
}

interface MemoryMediaRow {
  object_key: string;
  content_type: string;
  position: number;
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

export async function analyzeTextIllustrationEmotion(
  content: string,
): Promise<{ emotion: string; colorPalette: string }> {
  // URLs are stripped before every prompt call site (docs/plans/inline-links.md
  // §8): they pollute the emotion prompt and fetched titles are untrusted
  // third-party content that must never reach the model.
  const result = await chatJson<{ emotion?: string; colorPalette?: string }>(
    buildEmotionSystemPrompt(),
    stripUrls(content),
  );

  const normalized = normalizeEmotionLabel(result.emotion, EMOTION_PALETTES);
  return {
    emotion: normalized.emotion,
    colorPalette: result.colorPalette ?? normalized.colorPalette,
  };
}

export async function analyzeMediaPhotoEmotion(input: {
  content: string | null;
  mediaKey: string;
  mediaContentType: string;
}): Promise<{ emotion: string; colorPalette: string }> {
  const bytes = await getObjectBytes(input.mediaKey);
  const prepared = await prepareVisionImageFromBytes(bytes, input.mediaContentType);

  if ('code' in prepared) {
    if (prepared.code === 'file_too_large') {
      throw new Error('file_too_large');
    }

    throw new Error('unsupported_image_format');
  }

  const result = await chatJsonWithVision<{ emotion?: string; colorPalette?: string }>(
    buildMediaEmotionSystemPrompt(),
    buildEmotionVisionUserPrompt(input.content ? stripUrls(input.content) : input.content),
    prepared,
  );

  const normalized = normalizeEmotionLabel(result.emotion, EMOTION_PALETTES);
  return {
    emotion: normalized.emotion,
    colorPalette: result.colorPalette ?? normalized.colorPalette,
  };
}

export interface MediaPhotoValidationError {
  status: number;
  message: string;
  code: string;
}

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
  const imageAsset = mediaAssets.find((asset) =>
    isAllowedImageMediaContentType(asset.content_type)
  );

  if (imageAsset) {
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

export async function updateEmotionIfSnapshotMatches(
  supabase: ReturnType<typeof createUserClient>,
  memoryId: string,
  emotion: string,
  snapshot: { updated_at: string; content: string | null },
): Promise<boolean> {
  const query = supabase
    .from('memories')
    .update({ emotion })
    .eq('id', memoryId)
    .eq('updated_at', snapshot.updated_at);

  const { data, error } = await query.select('id').maybeSingle();

  if (error) {
    console.error('analyze-emotion emotion update failed', error.message);
    throw error;
  }

  return Boolean(data);
}

export async function handleAnalyzeEmotion(req: Request): Promise<Response> {
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
  // Emotion writes must land through the service-role client: a viewer's
  // user-client UPDATE would silently match zero rows under the manager+
  // `memories` policy (200 with no-op), leaving `isEmotionAnalyzable` true
  // and causing a permanent client retry loop. Membership (any role, below)
  // authorizes triggering analysis; the enrichment write is a system write.
  const serviceClient = createServiceClient();

  const { data: memory, error: memoryError } = await supabase
    .from('memories')
    .select('id, family_id, content, memory_type, media_key, media_content_type, updated_at')
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

      const analyzed = await analyzeTextIllustrationEmotion(row.content);
      await serviceClient.from('memories').update({ emotion: analyzed.emotion }).eq('id', memoryId);

      const response: AnalyzeEmotionResponse = {
        emotion: analyzed.emotion,
        colorPalette: analyzed.colorPalette,
      };

      return jsonResponse(response);
    }

    const { data: mediaRows, error: mediaError } = await supabase
      .from('memory_media')
      .select('object_key, content_type, position')
      .eq('memory_id', memoryId)
      .order('position', { ascending: true });

    if (mediaError) {
      console.error('analyze-emotion media lookup failed', mediaError.message);
      return errorResponse('Failed to load media assets', 500, 'internal_error');
    }

    const orderedMedia = (mediaRows ?? []) as MemoryMediaRow[];
    const mediaValidationError = validateMediaPhotoMemoryRow(row, orderedMedia);
    if (mediaValidationError) {
      return errorResponse(
        mediaValidationError.message,
        mediaValidationError.status,
        mediaValidationError.code,
      );
    }

    const imageAsset = orderedMedia.find((asset) =>
      isAllowedImageMediaContentType(asset.content_type)
    );
    const mediaKey = imageAsset?.object_key ?? row.media_key!;
    const mediaContentType = imageAsset?.content_type ?? row.media_content_type ?? '';

    const analyzed = await analyzeMediaPhotoEmotion({
      content: row.content,
      mediaKey,
      mediaContentType,
    });

    const updated = await updateEmotionIfSnapshotMatches(
      serviceClient,
      memoryId,
      analyzed.emotion,
      snapshot,
    );

    const response: AnalyzeEmotionResponse = {
      emotion: analyzed.emotion,
      colorPalette: analyzed.colorPalette,
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
