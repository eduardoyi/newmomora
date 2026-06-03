import { describeAgeAtDate, isAdultAtDate } from '../_shared/age.ts';
import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { editImageWithReferences, generateImage } from '../_shared/openai.ts';
import { capImageMaxEdge } from '../_shared/image-bytes.ts';
import { MAX_PORTRAIT_REFERENCE_EDGE } from '../_shared/image-limits.ts';
import { buildCharacterSheetAbstractionAddon, buildPortraitPrompt } from '../_shared/prompts.ts';
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getIllustrationStyle,
  loadStyleReferenceBytes,
} from '../_shared/styles.ts';
import {
  buildFamilyPortraitKey,
  assertUserOwnedKey,
} from '../_shared/storage-keys.ts';
import { getObjectBytes, putObjectBytes } from '../_shared/r2.ts';
import { createUserClient } from '../_shared/supabase-admin.ts';

export interface GeneratePortraitRequest {
  familyMemberId: string;
}

export interface GeneratePortraitResponse {
  success: true;
  illustratedProfileKey: string;
}

export async function handleGeneratePortraitIllustration(req: Request): Promise<Response> {
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

  let body: GeneratePortraitRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { familyMemberId } = body;

  if (!familyMemberId || typeof familyMemberId !== 'string') {
    return errorResponse('familyMemberId is required', 400, 'validation_error');
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = createUserClient(authHeader);

  const { data: member, error: memberError } = await supabase
    .from('family_members')
    .select('*')
    .eq('id', familyMemberId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (memberError) {
    console.error('generate-portrait-illustration member lookup failed', memberError.message);
    return errorResponse('Failed to load family member', 500, 'internal_error');
  }

  if (!member) {
    return errorResponse('Family member not found', 404, 'MEMBER_NOT_FOUND');
  }

  if (!member.profile_picture_key) {
    return errorResponse('Profile photo is required', 400, 'PHOTO_MISSING');
  }

  try {
    assertUserOwnedKey(member.profile_picture_key, user.id);
  } catch {
    return errorResponse('Invalid profile photo key', 400, 'validation_error');
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('illustration_style')
    .eq('id', user.id)
    .maybeSingle();

  const styleToken = profile?.illustration_style ?? DEFAULT_ILLUSTRATION_STYLE_TOKEN;
  const style = getIllustrationStyle(styleToken);
  const portraitKey = buildFamilyPortraitKey(user.id, familyMemberId);

  await supabase
    .from('family_members')
    .update({ illustrated_profile_status: 'generating' })
    .eq('id', familyMemberId);

  try {
    const photoBytes = await getObjectBytes(member.profile_picture_key);
    const cappedPhoto = await capImageMaxEdge(
      photoBytes,
      MAX_PORTRAIT_REFERENCE_EDGE,
      'image/jpeg',
    );
    const referenceDate = new Date().toISOString().slice(0, 10);
    const ageDescription = member.date_of_birth
      ? describeAgeAtDate(member.date_of_birth, referenceDate)
      : 'young child';
    const isAdult = member.date_of_birth
      ? isAdultAtDate(member.date_of_birth, referenceDate)
      : false;

    const prompt = `${buildPortraitPrompt({
      name: member.name,
      ageDescription,
      isAdult,
      gender: member.gender,
      styleToken: style.token,
      additionalInfo: member.additional_info,
    })} ${buildCharacterSheetAbstractionAddon(isAdult)}`;

    const referenceImages: Array<{
      bytes: Uint8Array;
      contentType: string;
      filename: string;
    }> = [];

    const styleReference = await loadStyleReferenceBytes(style.token);

    if (styleReference) {
      const cappedStyle = await capImageMaxEdge(
        styleReference.bytes,
        MAX_PORTRAIT_REFERENCE_EDGE,
        styleReference.contentType,
      );
      referenceImages.push({
        bytes: cappedStyle.bytes,
        contentType: cappedStyle.contentType,
        filename: 'reference-1-style.png',
      });
    } else {
      console.error('generate-portrait-illustration style reference unavailable', style.token);
    }

    referenceImages.push({
      bytes: cappedPhoto.bytes,
      contentType: cappedPhoto.contentType,
      filename: 'reference-2-person-photo.jpg',
    });

    let portraitBytes: Uint8Array;

    try {
      portraitBytes = await editImageWithReferences(prompt, referenceImages);
    } catch {
      portraitBytes = await generateImage(prompt);
    }

    await putObjectBytes(portraitKey, portraitBytes, 'image/webp');

    await supabase
      .from('family_members')
      .update({
        illustrated_profile_key: portraitKey,
        illustrated_profile_status: 'ready',
      })
      .eq('id', familyMemberId);

    const response: GeneratePortraitResponse = {
      success: true,
      illustratedProfileKey: portraitKey,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error(
      'generate-portrait-illustration failed',
      error instanceof Error ? error.message : 'unknown',
    );

    await supabase
      .from('family_members')
      .update({ illustrated_profile_status: 'failed' })
      .eq('id', familyMemberId);

    return errorResponse('Portrait generation failed', 500, 'GENERATION_FAILED');
  }
}

if (import.meta.main) {
  Deno.serve(handleGeneratePortraitIllustration);
}
