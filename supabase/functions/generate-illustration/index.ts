import { describeAgeAtDate } from '../_shared/age.ts';
import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { chatJson, editImageWithReferences } from '../_shared/openai.ts';
import {
  prepareIllustrationReferences,
  sortMembersByTagOrder,
} from '../_shared/illustration-references.ts';
import {
  buildIllustrationPrompt,
  buildSafetySystemPrompt,
  EMOTION_PALETTES,
} from '../_shared/prompts.ts';
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getStyleDescription,
} from '../_shared/styles.ts';
import { deleteObject, getObjectBytes, putObjectBytes } from '../_shared/r2.ts';
import { buildMemoryIllustrationKey } from '../_shared/storage-keys.ts';
import { resolveMemberIdsForIllustration } from '../_shared/illustration-members.ts';
import { isIllustrationGenerationStale } from '../_shared/illustration-status.ts';
import { createUserClient } from '../_shared/supabase-admin.ts';

export interface GenerateIllustrationRequest {
  memoryId: string;
  colorPalette?: string;
  /** When true, regenerate even if an illustration is already ready. */
  forceRegenerate?: boolean;
}

export interface GenerateIllustrationResponse {
  success: true;
  illustrationKey: string;
}

interface ReadyFamilyMember {
  id: string;
  name: string;
  nicknames: string[] | null;
  date_of_birth: string | null;
  gender: string | null;
  additional_info: string | null;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string | null;
  profile_picture_key: string | null;
}

const EMPTY_MEMBER_ID = '00000000-0000-4000-8000-000000000000';

export async function handleGenerateIllustration(req: Request): Promise<Response> {
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

  let body: GenerateIllustrationRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { memoryId, colorPalette, forceRegenerate = false } = body;

  if (!memoryId || typeof memoryId !== 'string') {
    return errorResponse('memoryId is required', 400, 'validation_error');
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = createUserClient(authHeader);

  const { data: memory, error: memoryError } = await supabase
    .from('memories')
    .select(
      'id, family_id, content, memory_date, emotion, illustration_key, illustration_status, updated_at, memory_type',
    )
    .eq('id', memoryId)
    .maybeSingle();

  if (memoryError) {
    console.error('generate-illustration memory lookup failed', memoryError.message);
    return errorResponse('Failed to load memory', 500, 'internal_error');
  }

  if (!memory) {
    return errorResponse('Memory not found', 404, 'MEMORY_NOT_FOUND');
  }

  const callerRole = await getCallerFamilyRole(supabase, memory.family_id, user.id);
  if (!isManagerRole(callerRole)) {
    return errorResponse('Not authorized for this memory', 403, 'forbidden');
  }

  if (memory.memory_type !== 'text_illustration' || !memory.content?.trim()) {
    return errorResponse(
      'Illustration only supported for text_illustration memories',
      400,
      'invalid_memory_type',
    );
  }

  if (
    !forceRegenerate &&
    memory.illustration_status === 'ready' &&
    memory.illustration_key
  ) {
    const response: GenerateIllustrationResponse = {
      success: true,
      illustrationKey: memory.illustration_key,
    };
    return jsonResponse(response);
  }

  if (
    !forceRegenerate &&
    memory.illustration_status === 'generating' &&
    !isIllustrationGenerationStale(memory.illustration_status, memory.updated_at)
  ) {
    return errorResponse('Illustration generation in progress', 409, 'GENERATION_IN_PROGRESS');
  }

  const { data: tagRows, error: tagError } = await supabase
    .from('memory_family_members')
    .select('family_member_id')
    .eq('memory_id', memoryId);

  if (tagError) {
    console.error('generate-illustration tag lookup failed', tagError.message);
    return errorResponse('Failed to load memory tags', 500, 'internal_error');
  }

  let memberIds = (tagRows ?? []).map((row) => row.family_member_id);

  if (memberIds.length === 0) {
    const { data: nameRows, error: nameRowsError } = await supabase
      .from('family_members')
      .select('id, name, nicknames')
      .eq('family_id', memory.family_id);

    if (nameRowsError) {
      console.error('generate-illustration name lookup failed', nameRowsError.message);
      return errorResponse('Failed to load family members', 500, 'internal_error');
    }

    memberIds = resolveMemberIdsForIllustration(memberIds, memory.content, nameRows ?? []);
  }

  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select(
      'id, name, nicknames, date_of_birth, gender, additional_info, illustrated_profile_key, illustrated_profile_status, profile_picture_key',
    )
    .eq('family_id', memory.family_id)
    .in('id', memberIds.length > 0 ? memberIds : [EMPTY_MEMBER_ID]);

  if (membersError) {
    console.error('generate-illustration members lookup failed', membersError.message);
    return errorResponse('Failed to load family members', 500, 'internal_error');
  }

  const readyMembers = sortMembersByTagOrder(
    (members ?? []).filter(
      (member) => member.illustrated_profile_status === 'ready' && member.illustrated_profile_key,
    ),
    memberIds,
  );

  if (readyMembers.length === 0) {
    await supabase.from('memories').update({ illustration_status: 'failed' }).eq('id', memoryId);

    return errorResponse('No ready character portraits for tagged members', 400, 'NO_PORTRAITS');
  }

  const { data: family } = await supabase
    .from('families')
    .select('illustration_style')
    .eq('id', memory.family_id)
    .maybeSingle();

  const styleDescription = getStyleDescription(
    family?.illustration_style ?? DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  );

  const illustrationKey = buildMemoryIllustrationKey(user.id, memoryId);
  const resolvedPalette =
    colorPalette ??
    (memory.emotion ? EMOTION_PALETTES[memory.emotion] : undefined) ??
    EMOTION_PALETTES.tender;

  await supabase
    .from('memories')
    .update({ illustration_status: 'generating' })
    .eq('id', memoryId);

  let generationSucceeded = false;

  try {
    const safety = await chatJson<{ safeDescription?: string }>(
      buildSafetySystemPrompt(),
      memory.content,
    );

    const safeDescription = safety.safeDescription?.trim() || memory.content.slice(0, 280);
    const { characterReferences, referenceImages } = await prepareIllustrationReferences(
      readyMembers,
      memory.memory_date,
      getObjectBytes,
    );

    if (referenceImages.length === 0) {
      throw new Error('Failed to load portrait references for tagged members');
    }

    const prompt = buildIllustrationPrompt({
      safeSceneDescription: safeDescription,
      characterReferences,
      colorPalette: resolvedPalette,
      memoryDate: memory.memory_date,
      styleDescription,
    });

    const illustrationBytes = await editImageWithReferences(prompt, referenceImages);

    if (memory.illustration_key && memory.illustration_key !== illustrationKey) {
      try {
        await deleteObject(memory.illustration_key);
      } catch {
        // Best effort cleanup.
      }
    }

    await putObjectBytes(illustrationKey, illustrationBytes, 'image/webp');

    await supabase
      .from('memories')
      .update({
        illustration_key: illustrationKey,
        illustration_prompt: prompt,
        illustration_status: 'ready',
      })
      .eq('id', memoryId);

    generationSucceeded = true;

    const response: GenerateIllustrationResponse = {
      success: true,
      illustrationKey,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error('generate-illustration failed', error instanceof Error ? error.message : 'unknown');

    return errorResponse('Illustration generation failed', 500, 'GENERATION_FAILED');
  } finally {
    if (!generationSucceeded) {
      await supabase
        .from('memories')
        .update({ illustration_status: 'failed' })
        .eq('id', memoryId)
        .in('illustration_status', ['pending', 'generating']);
    }
  }
}

if (import.meta.main) {
  Deno.serve(handleGenerateIllustration);
}
