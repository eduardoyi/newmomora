/**
 * Exact R2 setup/cleanup for the Looking Back Maestro fixture.
 *
 * This helper is intentionally not general-purpose: the account, memory,
 * generation and asset IDs are fixed below, the endpoint must be loopback,
 * and every mutation requires an explicit isolated-R2 opt-in. It imports the
 * same byte helpers used by production functions but can create a valid
 * versioned illustration object, which the public media upload endpoint is
 * not designed to accept.
 */
import {
  deleteObject,
  getObjectBytes,
  putObjectBytes,
} from "../functions/_shared/r2.ts";

const fixtureUserId = "8e000000-0000-4000-8000-000000000001";
const fixtureIllustrationMemoryId = "8e400000-0000-4000-8000-000000000003";
const fixtureMediaMemoryId = "8e400000-0000-4000-8000-000000000004";
const fixturePhotoAssetId = "8e500000-0000-4000-8000-000000000001";
const fixtureVideoAssetId = "8e500000-0000-4000-8000-000000000002";
const fixtureIllustrationGenerationId = "8e700000-0000-4000-8000-000000000001";

const illustrationKey =
  `${fixtureUserId}/memories/${fixtureIllustrationMemoryId}/illustrations/${fixtureIllustrationGenerationId}.webp`;
const photoKey =
  `${fixtureUserId}/memories/${fixtureMediaMemoryId}/media/${fixturePhotoAssetId}.jpg`;
const videoKey =
  `${fixtureUserId}/memories/${fixtureMediaMemoryId}/media/${fixtureVideoAssetId}.mp4`;
const exactKeys = [illustrationKey, photoKey, videoKey] as const;

function fail(message: string): never {
  throw new Error(`Refusing Looking Back R2 fixture mutation: ${message}`);
}

function validateIsolatedR2(): void {
  if (Deno.env.get("LOOKING_BACK_E2E_R2_ALLOW_ISOLATED") !== "1") {
    fail("set LOOKING_BACK_E2E_R2_ALLOW_ISOLATED=1.");
  }

  const rawEndpoint = Deno.env.get("R2_ENDPOINT");
  if (!rawEndpoint) fail("R2_ENDPOINT is required.");

  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    fail("R2_ENDPOINT must be a valid URL.");
  }

  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    fail(
      "R2_ENDPOINT must be an exact http://127.0.0.1:<port> local endpoint.",
    );
  }

  if (!Deno.env.get("R2_BUCKET")) fail("R2_BUCKET is required.");
}

async function deleteExactObjects(): Promise<void> {
  const results = await Promise.allSettled(
    exactKeys.map((key) => deleteObject(key)),
  );
  const failureCount =
    results.filter((result) => result.status === "rejected").length;
  if (failureCount > 0) {
    throw new Error(
      `Failed to delete ${failureCount} Looking Back fixture object(s).`,
    );
  }
}

async function uploadExactObjects(
  photoPath: string,
  videoPath: string,
): Promise<void> {
  const [illustrationBytes, photoBytes, videoBytes] = await Promise.all([
    Deno.readFile("assets/onboarding/year-fort-hallway.webp"),
    Deno.readFile(photoPath),
    Deno.readFile(videoPath),
  ]);

  if (
    illustrationBytes.length === 0 || photoBytes.length === 0 ||
    videoBytes.length === 0
  ) {
    fail("fixture media bytes must be non-empty.");
  }

  try {
    await putObjectBytes(illustrationKey, illustrationBytes, "image/webp");
    await putObjectBytes(photoKey, photoBytes, "image/jpeg");
    await putObjectBytes(videoKey, videoBytes, "video/mp4");

    const storedLengths = await Promise.all(
      exactKeys.map(async (key) => (await getObjectBytes(key)).length),
    );
    const expectedLengths = [
      illustrationBytes.length,
      photoBytes.length,
      videoBytes.length,
    ];
    if (
      storedLengths.some((length, index) => length !== expectedLengths[index])
    ) {
      throw new Error("Stored fixture byte length did not match its source.");
    }
  } catch (error) {
    await deleteExactObjects().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  validateIsolatedR2();
  const [action, photoPath, videoPath] = Deno.args;

  if (action === "upload") {
    if (!photoPath || !videoPath || Deno.args.length !== 3) {
      fail("upload requires exactly one generated JPEG and MP4 path.");
    }
    await uploadExactObjects(photoPath, videoPath);
    console.log("LOOKING_BACK_STORAGE_UPLOADED=3");
    return;
  }

  if (action === "cleanup" && Deno.args.length === 1) {
    await deleteExactObjects();
    console.log("LOOKING_BACK_STORAGE_CLEANED=3");
    return;
  }

  fail("expected upload <photo-path> <video-path> or cleanup.");
}

if (import.meta.main) {
  await main();
}
