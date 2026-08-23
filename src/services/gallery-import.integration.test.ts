import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';

import {
  beginGalleryImportApproval,
  createGalleryImportRun,
  dispatchGalleryImportChunk,
  getGalleryImportCandidates,
  getGalleryImportRun,
  registerGalleryImportChunk,
  updateGalleryCaptionSettings,
} from '@/services/gallery-import';
import { GALLERY_IMPORT_EDGE_TIMEOUT_MS } from '@/constants/gallery-import';
import { supabase } from '@/lib/supabase';

jest.mock('@/utils/gallery-import-flags', () => ({ isGalleryImportFeatureEnabled: true }));

jest.mock('@/lib/supabase', () => ({
  supabase: { functions: { invoke: jest.fn() } },
}));

const invoke = supabase.functions.invoke as jest.MockedFunction<typeof supabase.functions.invoke>;

function findForbiddenPayloadKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value)) {
    if (['osassetid', 'filename', 'uri', 'exif', 'location'].includes(key.toLowerCase())) return key;
    const child = findForbiddenPayloadKey(nested);
    if (child) return child;
  }
  return null;
}

describe('gallery import service integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (jest.requireMock('@/utils/gallery-import-flags') as { isGalleryImportFeatureEnabled: boolean })
      .isGalleryImportFeatureEnabled = true;
  });

  it('starts a server-authorized run and leaves the run capability in the response only', async () => {
    invoke.mockResolvedValue({
      data: {
        run: { id: 'run-1', familyId: 'family-1', status: 'scanning', reviewExpiresAt: null, limits: {} },
        runCapability: 'private-device-capability',
      },
      error: null,
    } as never);

    await expect(createGalleryImportRun({ familyId: 'family-1', algorithmVersion: 'gallery-v1', consentVersion: 'v1', permissionMode: 'full' })).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ runCapability: 'private-device-capability' }) }),
    );
    expect(invoke).toHaveBeenCalledWith('create-gallery-import-run', {
      body: { familyId: 'family-1', algorithmVersion: 'gallery-v1', consentVersion: 'v1', permissionMode: 'full' },
      timeout: GALLERY_IMPORT_EDGE_TIMEOUT_MS,
    });
  });

  it('sends opaque manifest tokens and never accepts an OS asset id field', async () => {
    invoke.mockResolvedValue({ data: { chunkId: 'chunk-1' }, error: null } as never);
    await registerGalleryImportChunk({
      familyId: 'family-1',
      runId: 'run-1',
      runCapability: 'private-device-capability',
      ordinal: 0,
      clusters: [{
        clusterSignature: 'digest-only',
        assets: [{ assetToken: 'opaque-token', captureDate: '2026-08-09', width: 12, height: 9, isFavorite: false }],
      }],
    });
    const body = invoke.mock.calls[0][1]?.body;
    expect(findForbiddenPayloadKey(body)).toBeNull();
    expect(body).toEqual(expect.objectContaining({
      clusters: [expect.objectContaining({ assets: [expect.objectContaining({ assetToken: 'opaque-token' })] })],
    }));
  });

  it('treats no active run as a normal empty response', async () => {
    invoke.mockResolvedValue({ data: null, error: null } as never);
    await expect(getGalleryImportRun({ runId: 'run-1', runCapability: 'device-only' })).resolves.toEqual({ data: null, error: null });
    expect(invoke).toHaveBeenCalledWith('get-gallery-import-run', { body: { runId: 'run-1', runCapability: 'device-only' }, timeout: GALLERY_IMPORT_EDGE_TIMEOUT_MS });
  });

  it('surfaces the safe structured Edge error instead of a generic non-2xx transport message', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: new FunctionsHttpError(new Response(JSON.stringify({
        error: 'Gallery preview is not available for upload',
        code: 'not_available',
      }), { status: 409, headers: { 'content-type': 'application/json' } })),
    } as never);

    await expect(createGalleryImportRun({
      familyId: 'family-1',
      algorithmVersion: 'gallery-v1',
      consentVersion: 'gallery-import-v1',
      permissionMode: 'full',
    })).resolves.toEqual({
      data: null,
      error: { message: 'Gallery preview is not available for upload', code: 'not_available' },
    });
  });

  it('maps a fair-use 429 into a retryable error carrying retryAfterSeconds (S2)', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: new FunctionsHttpError(new Response(JSON.stringify({
        error: 'Gallery import daily limit reached',
        code: 'fair_use',
        retryAfterSeconds: 3600,
      }), { status: 429, headers: { 'content-type': 'application/json' } })),
    } as never);

    await expect(registerGalleryImportChunk({ familyId: 'family-1', runId: 'run-1', runCapability: 'cap', ordinal: 0, clusters: [] }))
      .resolves.toEqual({ data: null, error: { message: 'Gallery import daily limit reached', code: 'fair_use', retryAfterSeconds: 3600 } });
  });

  it('maps a request that exceeds the Edge timeout into a distinguishable, content-free retryable error', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    invoke.mockResolvedValue({ data: null, error: new FunctionsFetchError(abortError) } as never);

    await expect(getGalleryImportRun({ runId: 'run-1', runCapability: 'cap' })).resolves.toEqual({
      data: null,
      error: expect.objectContaining({ code: 'timeout' }),
    });
    // Never leak the underlying fetch/abort message -- content-free per CLAUDE.md.
    const { error } = await getGalleryImportRun({ runId: 'run-1', runCapability: 'cap' });
    expect(error?.message).not.toMatch(/abort/i);
  });

  it('races every gallery Edge call against GALLERY_IMPORT_EDGE_TIMEOUT_MS', async () => {
    invoke.mockResolvedValue({ data: { candidates: [] }, error: null } as never);
    await getGalleryImportCandidates({ runId: 'run-1', capability: 'cap' });
    expect(invoke).toHaveBeenCalledWith('get-gallery-import-candidates', expect.objectContaining({ timeout: GALLERY_IMPORT_EDGE_TIMEOUT_MS }));
  });

  it('passes unavailableAssetTokens through to dispatch (S3)', async () => {
    invoke.mockResolvedValue({ data: { accepted: true }, error: null } as never);
    await dispatchGalleryImportChunk({
      familyId: 'family-1', runId: 'run-1', runCapability: 'cap', chunkId: 'chunk-1',
      previewUploads: [], unavailableAssetTokens: ['gone-token'],
    });
    expect(invoke).toHaveBeenCalledWith('dispatch-gallery-import-chunk', expect.objectContaining({
      body: expect.objectContaining({ unavailableAssetTokens: ['gone-token'] }),
    }));
  });

  it('rejects unsupported locale/instructions before calling the server', async () => {
    await expect(updateGalleryCaptionSettings({
      familyId: 'family-1', language: 'x-invalid', instructions: 'warm',
    })).resolves.toEqual(expect.objectContaining({ error: expect.objectContaining({ code: 'validation_error' }) }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('canonicalizes allowed caption settings before autosaving them', async () => {
    invoke.mockResolvedValue({
      data: { language: 'pt-BR', instructions: 'Use gentle Brazilian Portuguese.', updatedAt: null }, error: null,
    } as never);
    await updateGalleryCaptionSettings({
      familyId: 'family-1', language: 'pt-br', instructions: 'Use gentle Brazilian Portuguese.',
    });
    expect(invoke).toHaveBeenCalledWith('update-gallery-caption-settings', {
      body: {
        familyId: 'family-1',
        language: 'pt-BR',
        instructions: 'Use gentle Brazilian Portuguese.',
      },
      timeout: GALLERY_IMPORT_EDGE_TIMEOUT_MS,
    });
  });

  it('fails closed before a mutation reaches the server when rollout is disabled', async () => {
    (jest.requireMock('@/utils/gallery-import-flags') as { isGalleryImportFeatureEnabled: boolean })
      .isGalleryImportFeatureEnabled = false;
    await expect(createGalleryImportRun({ familyId: 'family-1', algorithmVersion: 'gallery-v1', consentVersion: 'v1', permissionMode: 'full' })).resolves.toEqual({
      data: null,
      error: expect.objectContaining({ code: 'feature_disabled' }),
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps capability-bound resume, review, and approval callable after the entry flag is disabled', async () => {
    (jest.requireMock('@/utils/gallery-import-flags') as { isGalleryImportFeatureEnabled: boolean })
      .isGalleryImportFeatureEnabled = false;
    invoke.mockImplementation(async (name) => ({
      data: name === 'register-gallery-import-chunk'
        ? { chunkId: 'chunk-1', acceptedAssetTokens: ['opaque-token'], suppressedClusterSignatures: [] }
        : name === 'get-gallery-import-candidates'
          ? { candidates: [] }
          : { leaseId: 'lease-1', memoryId: 'memory-1', expiresAt: '2099-01-01T00:00:00.000Z', expectedAssets: [] },
      error: null,
    } as never));

    await registerGalleryImportChunk({ familyId: 'family-1', runId: 'run-1', runCapability: 'cap', ordinal: 0, clusters: [] });
    await getGalleryImportCandidates({ runId: 'run-1', capability: 'cap' });
    await beginGalleryImportApproval({ candidateId: 'candidate-1', capability: 'cap', assets: [] });

    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'register-gallery-import-chunk',
      'get-gallery-import-candidates',
      'begin-gallery-import-approval',
    ]);
  });
});
