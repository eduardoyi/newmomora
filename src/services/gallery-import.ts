import { FunctionsHttpError } from '@supabase/supabase-js';

import {
  normalizeGalleryCaptionLocale,
  validateGalleryCaptionInstructions,
  type GalleryCaptionLocaleTag,
} from '@/constants/gallery-caption-locales';
import { supabase } from '@/lib/supabase';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { invokeGalleryImportE2e } from '@/utils/gallery-import-e2e-adapter';

export interface GalleryImportServiceError {
  message: string;
  code?: string;
}

export interface GalleryImportLimits {
  maxClusters: number;
  maxAssetsPerCluster: number;
  maxChunks: number;
}

export interface GalleryImportRun {
  id: string;
  familyId: string;
  status: 'scanning' | 'processing' | 'reviewing' | 'completed' | 'cancelled' | 'expired' | 'failed';
  reviewExpiresAt: string | null;
  limits: GalleryImportLimits;
  readyCandidates?: number;
  chunkCount?: number;
  /** Round 4: server-computed count of clusters registered but not yet
   * resolved (see supabase/functions/_shared/gallery-import.ts's
   * countPendingGalleryClusters) -- server truth for "+N coming", unlike
   * the client's own local upload plan, which goes stale across a resume.
   * `null`/absent means the server could not compute it; never render a
   * number in that case. */
  pendingClusters?: number | null;
}

/** A curation draft. It deliberately contains no model explanation or emotion. */
export interface GalleryImportCandidate {
  id: string;
  caption: string;
  memoryDate: string;
  selectedAssetTokens: string[];
  familyMemberIds: string[];
  status: 'ready' | 'kept' | 'skipped' | 'approving' | 'approved' | 'expired';
  /** Short-lived private URLs only; absent while previews have been scrubbed. */
  previewUrls?: string[];
}

export interface GalleryImportApprovalLease {
  leaseId: string;
  memoryId: string;
  expiresAt: string;
  expectedAssets: Array<{ assetToken: string; objectKey: string; contentType: GalleryOriginalContentType }>;
}

export type GalleryOriginalContentType = 'image/jpeg' | 'image/png' | 'image/heic' | 'image/heif' | 'image/webp';

export interface CreateGalleryImportRunResponse {
  run: GalleryImportRun;
  /** Store locally in an authenticated, run-scoped checkpoint only. */
  runCapability: string;
}

export interface GalleryImportManifestAsset {
  assetToken: string;
  captureDate: string;
  width: number | null;
  height: number | null;
  isFavorite: boolean;
}

export interface GalleryImportManifestCluster {
  clusterSignature: string;
  assets: GalleryImportManifestAsset[];
}

export interface GalleryImportRegisteredChunk {
  chunkId: string;
  /** Assets the server admitted for this run. Missing means contract failure. */
  acceptedAssetTokens: string[];
  /** Duplicate/permanently-suppressed clusters. Never preview or upload them. */
  suppressedClusterSignatures: string[];
}

export interface GalleryCaptionSettings {
  language: GalleryCaptionLocaleTag;
  instructions: string;
  updatedAt: string | null;
}

async function mapError(error: unknown): Promise<GalleryImportServiceError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = (await error.context.clone().json()) as { error?: unknown; code?: unknown };
      if (typeof body.error === 'string' && body.error.length > 0) {
        return {
          message: body.error,
          code: typeof body.code === 'string' ? body.code : String(error.context.status),
        };
      }
    } catch {
      // Fall through to the transport message when the response is not JSON.
    }
    return { message: error.message, code: String(error.context.status) };
  }
  return { message: error instanceof Error ? error.message : 'The gallery import service failed.' };
}

function galleryImportDisabledResult<T>(): { data: T | null; error: GalleryImportServiceError } | null {
  return isGalleryImportFeatureEnabled
    ? null
    : { data: null, error: { message: 'Gallery import is not available yet.', code: 'feature_disabled' } };
}

async function invokeGalleryImport<T>(
  functionName: string,
  body: Record<string, unknown>,
  options: { allowEmptyData?: boolean } = {},
): Promise<{ data: T | null; error: GalleryImportServiceError | null }> {
  try {
    const fixtureData = await invokeGalleryImportE2e<T>(functionName, body);
    if (fixtureData !== undefined) return { data: fixtureData, error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : 'The gallery E2E fixture failed.' } };
  }
  const { data, error } = await supabase.functions.invoke<T>(functionName, { body });
  if (error) return { data: null, error: await mapError(error) };
  if (!data && !options.allowEmptyData) return { data: null, error: { message: 'The gallery import service returned no data.' } };
  return { data, error: null };
}

export function createGalleryImportRun(
  input: {
    familyId: string;
    algorithmVersion: string;
    consentVersion: string;
    permissionMode: 'full' | 'limited';
  },
): Promise<{ data: CreateGalleryImportRunResponse | null; error: GalleryImportServiceError | null }> {
  const disabled = galleryImportDisabledResult<CreateGalleryImportRunResponse>();
  if (disabled) return Promise.resolve(disabled);
  return invokeGalleryImport('create-gallery-import-run', input);
}

export function getGalleryImportRun(
  input: { runId: string; runCapability: string },
): Promise<{ data: GalleryImportRun | null; error: GalleryImportServiceError | null }> {
  // No active run is a normal state, not a transport failure.
  return invokeGalleryImport('get-gallery-import-run', input, { allowEmptyData: true });
}

export function registerGalleryImportChunk(input: {
  familyId: string;
  runId: string;
  runCapability: string;
  ordinal: number;
  clusters: GalleryImportManifestCluster[];
}): Promise<{ data: GalleryImportRegisteredChunk | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('register-gallery-import-chunk', input);
}

export function getGalleryImportUploadUrl(input: {
  familyId: string;
  runId: string;
  runCapability: string;
  assetToken: string;
  contentType: 'image/jpeg';
  previewWidth: number;
  previewHeight: number;
  byteLength: number;
  sha256: string;
}): Promise<{ data: { uploadUrl: string; objectKey: string; expiresIn: number; requiredHeaders?: Record<string, string> } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('get-gallery-import-upload-url', input);
}

export function dispatchGalleryImportChunk(input: {
  familyId: string;
  runId: string;
  runCapability: string;
  chunkId: string;
  previewUploads: Array<{
    assetToken: string;
    contentType: 'image/jpeg';
    previewWidth: number;
    previewHeight: number;
    byteLength: number;
    sha256: string;
  }>;
}): Promise<{ data: { accepted: boolean } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('dispatch-gallery-import-chunk', input);
}

export function getGalleryImportCandidates(input: {
  runId: string;
  capability: string;
}): Promise<{ data: { candidates: GalleryImportCandidate[] } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('get-gallery-import-candidates', input);
}

export function setGalleryImportCandidateSkip(input: {
  candidateId: string;
  capability: string;
  skip: boolean;
}): Promise<{ data: { candidate: GalleryImportCandidate } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('set-gallery-import-candidate-skip', input);
}

export function updateGalleryImportCandidate(input: {
  candidateId: string;
  capability: string;
  caption: string;
  memoryDate: string;
  assetTokens: string[];
  familyMemberIds: string[];
}): Promise<{ data: { candidate: GalleryImportCandidate } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('update-gallery-import-candidate', input);
}

export function beginGalleryImportApproval(input: {
  candidateId: string;
  capability: string;
  assets: Array<{ assetToken: string; contentType: GalleryOriginalContentType }>;
}): Promise<{ data: GalleryImportApprovalLease | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('begin-gallery-import-approval', input);
}

export function getGalleryImportApprovalUploadUrl(input: {
  candidateId: string;
  capability: string;
  leaseId: string;
  assetToken: string;
  contentType: GalleryOriginalContentType;
  byteLength: number;
}): Promise<{ data: { objectKey: string; uploadUrl: string; requiredHeaders?: Record<string, string> } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('get-gallery-import-approval-upload-url', input);
}

export function recordGalleryImportApprovalUpload(input: {
  candidateId: string;
  capability: string;
  leaseId: string;
  assetToken: string;
  contentType: GalleryOriginalContentType;
  byteLength: number;
  aspectRatio?: number;
}): Promise<{ data: { recorded: boolean } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('record-gallery-import-approval-upload', input);
}

export function finalizeGalleryImportCandidate(input: {
  candidateId: string;
  capability: string;
}): Promise<{ data: { memoryId: string } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('finalize-gallery-import-candidate', input);
}

export function cancelGalleryImportRun(input: {
  runId: string;
  capability: string;
}): Promise<{ data: { cancelled: boolean } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('cancel-gallery-import-run', input);
}

export function completeGalleryImportRun(input: {
  runId: string;
  capability: string;
}): Promise<{ data: { completed: boolean } | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('complete-gallery-import-run', input);
}

export function getGalleryCaptionSettings(
  familyId: string,
): Promise<{ data: GalleryCaptionSettings | null; error: GalleryImportServiceError | null }> {
  return invokeGalleryImport('get-gallery-caption-settings', { familyId });
}

export async function updateGalleryCaptionSettings(input: {
  familyId: string;
  language: string;
  instructions: string;
}): Promise<{ data: GalleryCaptionSettings | null; error: GalleryImportServiceError | null }> {
  const disabled = galleryImportDisabledResult<GalleryCaptionSettings>();
  if (disabled) return disabled;
  const language = normalizeGalleryCaptionLocale(input.language);
  if (!language) {
    return { data: null, error: { message: 'Choose a supported caption language.', code: 'validation_error' } };
  }
  const validationError = validateGalleryCaptionInstructions(input.instructions);
  if (validationError) return { data: null, error: { message: validationError, code: 'validation_error' } };
  return invokeGalleryImport('update-gallery-caption-settings', {
    familyId: input.familyId,
    language,
    instructions: input.instructions,
  });
}
