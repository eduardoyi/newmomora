import { describeAgeAtDate, isAdultAtDate } from "../_shared/age.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { handleCors } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  getCallerFamilyRole,
  isManagerRole,
} from "../_shared/family-access.ts";
import { editImageWithReferences, generateImage } from "../_shared/openai.ts";
import { capImageMaxEdge } from "../_shared/image-bytes.ts";
import { MAX_PORTRAIT_REFERENCE_EDGE } from "../_shared/image-limits.ts";
import {
  buildCharacterSheetAbstractionAddon,
  buildPortraitPrompt,
} from "../_shared/prompts.ts";
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getIllustrationStyle,
  loadStyleReferenceBytes,
} from "../_shared/styles.ts";
import {
  buildPortraitVersionAttemptKey,
  parseStorageKey,
} from "../_shared/storage-keys.ts";
import { deleteObject, getObjectBytes, putObjectBytes } from "../_shared/r2.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

export interface GeneratePortraitRequest {
  portraitVersionId: string;
}

export interface GeneratePortraitResponse {
  success: true;
  queued: true;
}

export interface GeneratePortraitDependencies {
  getAuthenticatedUser: typeof getAuthenticatedUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  getObjectBytes: typeof getObjectBytes;
  capImageMaxEdge: typeof capImageMaxEdge;
  loadStyleReferenceBytes: typeof loadStyleReferenceBytes;
  editImageWithReferences: typeof editImageWithReferences;
  generateImage: typeof generateImage;
  putObjectBytes: typeof putObjectBytes;
  deleteObject: typeof deleteObject;
  generationTimeoutMs: number;
  waitUntil: (task: Promise<void>) => void;
}

export const PORTRAIT_GENERATION_TIMEOUT_MS = 90_000;

const DEFAULT_DEPENDENCIES: GeneratePortraitDependencies = {
  getAuthenticatedUser,
  createServiceClient,
  getCallerFamilyRole,
  getObjectBytes,
  capImageMaxEdge,
  loadStyleReferenceBytes,
  editImageWithReferences,
  generateImage,
  putObjectBytes,
  deleteObject,
  generationTimeoutMs: PORTRAIT_GENERATION_TIMEOUT_MS,
  waitUntil: (task) =>
    (
      globalThis as unknown as {
        EdgeRuntime: { waitUntil: (task: Promise<void>) => void };
      }
    ).EdgeRuntime.waitUntil(task),
};

export async function handleGeneratePortraitIllustration(
  req: Request,
  dependencyOverrides: Partial<GeneratePortraitDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405, "method_not_allowed");
  }

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  let body: GeneratePortraitRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400, "invalid_json");
  }

  const { portraitVersionId } = body;

  if (!portraitVersionId || typeof portraitVersionId !== "string") {
    return errorResponse(
      "portraitVersionId is required",
      400,
      "validation_error",
    );
  }

  const supabase = dependencies.createServiceClient();

  const { data: version, error: versionError } = await supabase
    .from("family_member_portrait_versions")
    .select("*")
    .eq("id", portraitVersionId)
    .maybeSingle();

  if (versionError) {
    console.error(
      "generate-portrait-illustration version lookup failed",
      versionError.message,
    );
    return errorResponse(
      "Failed to load portrait version",
      500,
      "internal_error",
    );
  }

  if (!version) {
    return errorResponse(
      "Portrait version not found",
      404,
      "PORTRAIT_VERSION_NOT_FOUND",
    );
  }

  const callerRole = await dependencies.getCallerFamilyRole(
    supabase,
    version.family_id,
    user.id,
  );
  if (!isManagerRole(callerRole)) {
    return errorResponse(
      "Not authorized for this portrait version",
      403,
      "forbidden",
    );
  }

  if (!version.reference_date) {
    return errorResponse(
      "Set a portrait date before generation",
      400,
      "DATE_REQUIRED",
    );
  }

  const { data: member, error: memberError } = await supabase
    .from("family_members")
    .select("*")
    .eq("id", version.family_member_id)
    .eq("family_id", version.family_id)
    .maybeSingle();
  if (memberError || !member) {
    return errorResponse("Family member not found", 404, "MEMBER_NOT_FOUND");
  }

  const parsedPhotoKey = parseStorageKey(version.profile_picture_key);
  if (
    !parsedPhotoKey ||
    parsedPhotoKey.kind !== "portrait_version_photo" ||
    parsedPhotoKey.portraitVersionId !== version.id ||
    parsedPhotoKey.entityId !== member.id
  ) {
    return errorResponse("Invalid profile photo key", 400, "validation_error");
  }

  const { data: family } = await supabase
    .from("families")
    .select("illustration_style")
    .eq("id", version.family_id)
    .maybeSingle();

  const styleToken = family?.illustration_style ??
    DEFAULT_ILLUSTRATION_STYLE_TOKEN;
  const style = getIllustrationStyle(styleToken);
  const attemptId = crypto.randomUUID();
  const portraitKey = buildPortraitVersionAttemptKey(
    parsedPhotoKey.ownerUserId,
    member.id,
    version.id,
    attemptId,
  );
  const { data: claimedVersion, error: claimError } = await supabase.rpc(
    "claim_family_member_portrait_generation",
    {
      target_version_id: version.id,
      attempt_token: attemptId,
      attempt_key: portraitKey,
      actor_user_id: user.id,
    },
  );
  if (claimError || !claimedVersion) {
    return errorResponse(
      "Portrait generation already in progress",
      409,
      "GENERATION_IN_PROGRESS",
    );
  }

  if (
    version.generation_output_key &&
    version.generation_output_key !== portraitKey
  ) {
    await dependencies.deleteObject(version.generation_output_key).catch(() =>
      undefined
    );
  }

  const completeGeneration = async (): Promise<void> => {
    let uploadedAttempt = false;
    const generationController = new AbortController();
    const generationTimeoutId = setTimeout(
      () => generationController.abort("Portrait generation deadline exceeded"),
      dependencies.generationTimeoutMs,
    );

    try {
      const photoBytes = await dependencies.getObjectBytes(
        version.profile_picture_key,
      );
      const cappedPhoto = await dependencies.capImageMaxEdge(
        photoBytes,
        MAX_PORTRAIT_REFERENCE_EDGE,
        "image/jpeg",
      );
      const referenceDate = version.reference_date;
      const ageDescription = member.date_of_birth
        ? describeAgeAtDate(member.date_of_birth, referenceDate)
        : "young child";
      const isAdult = member.date_of_birth
        ? isAdultAtDate(member.date_of_birth, referenceDate)
        : false;

      const prompt = `${
        buildPortraitPrompt({
          name: member.name,
          ageDescription,
          isAdult,
          gender: member.gender,
          styleToken: style.token,
          additionalInfo: member.additional_info,
        })
      } ${buildCharacterSheetAbstractionAddon(isAdult)}`;

      const referenceImages: Array<{
        bytes: Uint8Array;
        contentType: string;
        filename: string;
      }> = [];

      const styleReference = await dependencies.loadStyleReferenceBytes(
        style.token,
      );

      if (styleReference) {
        const cappedStyle = await dependencies.capImageMaxEdge(
          styleReference.bytes,
          MAX_PORTRAIT_REFERENCE_EDGE,
          styleReference.contentType,
        );
        referenceImages.push({
          bytes: cappedStyle.bytes,
          contentType: cappedStyle.contentType,
          filename: "reference-1-style.png",
        });
      } else {
        console.error(
          "generate-portrait-illustration style reference unavailable",
          style.token,
        );
      }

      referenceImages.push({
        bytes: cappedPhoto.bytes,
        contentType: cappedPhoto.contentType,
        filename: "reference-2-person-photo.jpg",
      });

      let portraitBytes: Uint8Array;

      try {
        portraitBytes = await dependencies.editImageWithReferences(
          prompt,
          referenceImages,
          {
            signal: generationController.signal,
          },
        );
      } catch {
        portraitBytes = await dependencies.generateImage(prompt, {
          signal: generationController.signal,
        });
      }

      await dependencies.putObjectBytes(
        portraitKey,
        portraitBytes,
        "image/webp",
      );
      uploadedAttempt = true;

      const { error: finishError } = await supabase.rpc(
        "finish_family_member_portrait_generation",
        {
          target_version_id: version.id,
          attempt_token: attemptId,
          generated_portrait_key: portraitKey,
        },
      );
      if (finishError) {
        // The request may have failed after Postgres committed. Re-read before
        // deleting the new object so a transient response failure cannot leave
        // a ready row pointing at deleted bytes.
        const { data: committedVersion } = await supabase
          .from("family_member_portrait_versions")
          .select("illustrated_profile_key, generation_token")
          .eq("id", version.id)
          .maybeSingle();
        if (
          committedVersion?.illustrated_profile_key !== portraitKey ||
          committedVersion.generation_token !== null
        ) {
          await dependencies.deleteObject(portraitKey).catch(() => undefined);
          console.error("generate-portrait-illustration generation claim lost");
          return;
        }
      }

      if (
        version.illustrated_profile_key &&
        version.illustrated_profile_key !== portraitKey
      ) {
        await dependencies.deleteObject(version.illustrated_profile_key).catch(
          () => undefined,
        );
      }
    } catch (error) {
      console.error(
        "generate-portrait-illustration failed",
        error instanceof Error ? error.message : "unknown",
      );

      await supabase.rpc("fail_family_member_portrait_generation", {
        target_version_id: version.id,
        attempt_token: attemptId,
      });
      if (uploadedAttempt) {
        await dependencies.deleteObject(portraitKey).catch(() => undefined);
      }
    } finally {
      clearTimeout(generationTimeoutId);
    }
  };

  dependencies.waitUntil(completeGeneration());
  const response: GeneratePortraitResponse = { success: true, queued: true };
  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve((request) => handleGeneratePortraitIllustration(request));
}
