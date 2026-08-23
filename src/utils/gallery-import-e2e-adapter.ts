import AsyncStorage from '@react-native-async-storage/async-storage';
import { Asset } from 'expo-asset';

import type {
  GalleryMediaLibraryAdapter,
  GalleryPhotoMetadata,
  GalleryPhotoPermission,
} from '@/utils/gallery-import-scanner';
import { isGalleryImportE2eAdapterEnabled } from '@/utils/gallery-import-flags';

export interface GalleryImportE2eFixture {
  permission?: GalleryPhotoPermission;
  assets: GalleryPhotoMetadata[];
  urisByAssetId?: Record<string, string>;
}

declare global {
  // Test harnesses may install an in-memory fixture before rendering the app.
  // It is read only behind the compile-time development flag below.
  var __MOMORA_GALLERY_IMPORT_E2E_FIXTURE__: GalleryImportE2eFixture | undefined;
}

const DEFAULT_FIXTURE_ASSETS: GalleryPhotoMetadata[] = [0, 1, 2].map((index) => ({
  id: `gallery-e2e-${index + 1}`,
  creationTime: Date.UTC(2025, 4, 12, 10 + index, 0, 0),
  mediaType: 'photo',
  width: 1200,
  height: 900,
  isFavorite: index === 0,
}));

async function bundledFixtureUri(): Promise<string> {
  const moduleId = require('../../assets/e2e/profile-fixture.jpg');
  const asset = Asset.fromModule(moduleId);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error('The gallery E2E fixture image is unavailable.');
  return uri;
}

/**
 * Development-client-only fixture adapter. The production expression is a
 * literal false after Metro compiles `__DEV__`, so neither this adapter nor a
 * test global can replace a real library in a store binary.
 */
export function getGalleryImportE2eAdapter(): GalleryMediaLibraryAdapter | undefined {
  if (!isGalleryImportE2eAdapterEnabled) return undefined;
  const fixture = globalThis.__MOMORA_GALLERY_IMPORT_E2E_FIXTURE__ ?? {
    assets: DEFAULT_FIXTURE_ASSETS,
  };
  const adapter = createGalleryImportE2eAdapter(fixture);
  return {
    ...adapter,
    resolveAssetUri: async (assetId) => fixture.urisByAssetId?.[assetId] ?? bundledFixtureUri(),
  };
}

/**
 * Intentionally does not fall back to the fixture adapter. Callers must opt in
 * in a development JS bundle, making it impossible for a production user to
 * silently scan fixtures or to skip the platform permission path.
 */
export function createGalleryImportE2eAdapter(
  fixture: GalleryImportE2eFixture,
): GalleryMediaLibraryAdapter {
  if (!isGalleryImportE2eAdapterEnabled) {
    throw new Error('The gallery-import E2E adapter is unavailable outside a development E2E build.');
  }
  let permission = fixture.permission ?? {
    granted: true,
    canAskAgain: true,
    accessPrivileges: 'all' as const,
  };
  return {
    getPermission: async () => permission,
    requestPermission: async () => {
      permission = { ...permission, granted: true, accessPrivileges: 'all' };
      return permission;
    },
    getPhotoPage: async ({ offset, limit }) => fixture.assets.slice(offset, offset + limit),
    isAssetAvailableLocally: async () => true,
    resolveAssetUri: async (assetId) => fixture.urisByAssetId?.[assetId] ?? `file:///e2e-gallery/${assetId}.jpg`,
  };
}

interface E2eCandidate {
  id: string;
  caption: string;
  memoryDate: string;
  selectedAssetTokens: string[];
  familyMemberIds: string[];
  status: 'ready' | 'skipped' | 'approved';
  previewUrls: string[];
}

interface E2eBackendState {
  run: {
    id: string; familyId: string; status: string; reviewExpiresAt: string | null;
    limits: { maxClusters: number; maxAssetsPerCluster: number; maxChunks: number };
    readyCandidates: number;
    // S1 additions -- fixture-only defaults, exercised end-to-end by the
    // deterministic E2E backend below rather than a real server.
    pendingClusters: number | null;
    chunks: Array<{ ordinal: number; status: 'registered' | 'uploading' | 'dispatched' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired' }>;
    liveCandidateAssetTokens: string[];
    fairUse: { pausedUntil: string | null };
  } | null;
  chunks: Array<{ id: string; ordinal: number; assetTokens: string[] }>;
  candidates: E2eCandidate[];
  captions: { language: string; instructions: string; updatedAt: string | null };
}

const E2E_BACKEND_KEY = 'gallery-import-e2e-backend-v1';
const initialBackendState = (): E2eBackendState => ({ run: null, chunks: [], candidates: [], captions: { language: 'en-GB', instructions: '', updatedAt: null } });

async function loadBackendState(): Promise<E2eBackendState> {
  const raw = await AsyncStorage.getItem(E2E_BACKEND_KEY);
  if (!raw) return initialBackendState();
  try { return JSON.parse(raw) as E2eBackendState; } catch { return initialBackendState(); }
}

async function saveBackendState(state: E2eBackendState): Promise<void> {
  await AsyncStorage.setItem(E2E_BACKEND_KEY, JSON.stringify(state));
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new Error(`Missing E2E ${key}.`);
  return value;
}

function assetsFromManifest(body: Record<string, unknown>): string[] {
  const clusters = Array.isArray(body.clusters) ? body.clusters : [];
  return clusters.flatMap((cluster) => {
    if (!cluster || typeof cluster !== 'object') return [];
    const assets = (cluster as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) return [];
    return assets.flatMap((asset) => asset && typeof asset === 'object' && typeof (asset as { assetToken?: unknown }).assetToken === 'string'
      ? [(asset as { assetToken: string }).assetToken]
      : []);
  });
}

/**
 * Local deterministic backend for Maestro. It is intentionally a client-only
 * dev seam: no deployed function, auth bypass, or production bundle branch is
 * involved. AsyncStorage makes a process relaunch exercise the same run.
 */
export async function invokeGalleryImportE2e<T>(functionName: string, body: Record<string, unknown>): Promise<T | undefined> {
  if (!isGalleryImportE2eAdapterEnabled) return undefined;
  const state = await loadBackendState();
  if (functionName === 'create-gallery-import-run') {
    state.run = {
      id: 'e2e-gallery-run', familyId: bodyString(body, 'familyId'), status: 'processing', reviewExpiresAt: null,
      limits: { maxClusters: 12, maxAssetsPerCluster: 10, maxChunks: 3 }, readyCandidates: 0,
      pendingClusters: null, chunks: [], liveCandidateAssetTokens: [], fairUse: { pausedUntil: null },
    };
    state.chunks = []; state.candidates = [];
    await saveBackendState(state);
    return { run: state.run, runCapability: 'e2e-gallery-capability' } as T;
  }
  if (functionName === 'get-gallery-import-run') return state.run as T;
  if (functionName === 'register-gallery-import-chunk') {
    const ordinal = Number(body.ordinal); const assetTokens = assetsFromManifest(body); const id = `e2e-gallery-chunk-${ordinal}`;
    state.chunks = [...state.chunks.filter((chunk) => chunk.id !== id), { id, ordinal, assetTokens }];
    if (state.run) {
      state.run = {
        ...state.run,
        chunks: [...state.run.chunks.filter((chunk) => chunk.ordinal !== ordinal), { ordinal, status: 'registered' }],
        pendingClusters: (state.run.pendingClusters ?? 0) + 1,
      };
    }
    await saveBackendState(state);
    return { chunkId: id, acceptedAssetTokens: assetTokens, suppressedClusterSignatures: [] } as T;
  }
  if (functionName === 'get-gallery-import-upload-url') return { uploadUrl: `e2e://gallery-import/preview/${bodyString(body, 'assetToken')}`, objectKey: 'e2e-preview', expiresIn: 3600, requiredHeaders: {} } as T;
  if (functionName === 'dispatch-gallery-import-chunk') {
    const tokens = state.chunks.flatMap((chunk) => chunk.assetTokens);
    if (state.run && state.candidates.length === 0) {
      const first = tokens.slice(0, Math.max(1, Math.ceil(tokens.length / 2)));
      const second = tokens.slice(first.length);
      const makeCandidate = (id: string, selectedAssetTokens: string[], caption: string): E2eCandidate => ({ id, caption, memoryDate: '2025-05-12', selectedAssetTokens, familyMemberIds: [], status: 'ready', previewUrls: selectedAssetTokens.map((token) => `e2e://gallery-import/preview/${token}`) });
      state.candidates = [makeCandidate('e2e-candidate-one', first, 'An afternoon worth keeping.'), makeCandidate('e2e-candidate-two', second.length > 0 ? second : first, 'A small family moment.')];
      state.run = {
        ...state.run,
        status: 'reviewing',
        readyCandidates: state.candidates.length,
        pendingClusters: 0,
        chunks: state.run.chunks.map((chunk) => ({ ...chunk, status: 'completed' as const })),
        liveCandidateAssetTokens: state.candidates.flatMap((candidate) => candidate.selectedAssetTokens),
      };
    }
    await saveBackendState(state);
    return { accepted: true } as T;
  }
  if (functionName === 'get-gallery-import-candidates') return { candidates: state.candidates.filter((candidate) => candidate.status !== 'approved') } as T;
  if (functionName === 'set-gallery-import-candidate-skip') {
    const candidate = state.candidates.find((item) => item.id === bodyString(body, 'candidateId'));
    if (!candidate) throw new Error('Missing E2E candidate.');
    candidate.status = body.skip === true ? 'skipped' : 'ready';
    await saveBackendState(state);
    return { candidate } as T;
  }
  if (functionName === 'update-gallery-import-candidate') {
    const candidate = state.candidates.find((item) => item.id === bodyString(body, 'candidateId'));
    if (!candidate) throw new Error('Missing E2E candidate.');
    candidate.caption = bodyString(body, 'caption'); candidate.memoryDate = bodyString(body, 'memoryDate');
    candidate.selectedAssetTokens = Array.isArray(body.assetTokens) ? body.assetTokens.filter((token): token is string => typeof token === 'string') : [];
    candidate.familyMemberIds = Array.isArray(body.familyMemberIds) ? body.familyMemberIds.filter((id): id is string => typeof id === 'string') : [];
    await saveBackendState(state);
    return { candidate } as T;
  }
  if (functionName === 'begin-gallery-import-approval') return { leaseId: `e2e-lease-${bodyString(body, 'candidateId')}`, memoryId: `e2e-memory-${bodyString(body, 'candidateId')}`, expiresAt: '2099-01-01T00:00:00.000Z', expectedAssets: [] } as T;
  if (functionName === 'get-gallery-import-approval-upload-url') return { objectKey: 'e2e-original', uploadUrl: `e2e://gallery-import/original/${bodyString(body, 'assetToken')}`, requiredHeaders: {} } as T;
  if (functionName === 'record-gallery-import-approval-upload') return { recorded: true } as T;
  if (functionName === 'finalize-gallery-import-candidate') {
    const candidate = state.candidates.find((item) => item.id === bodyString(body, 'candidateId'));
    if (!candidate) throw new Error('Missing E2E candidate.');
    candidate.status = 'approved';
    if (state.run) state.run.readyCandidates = state.candidates.filter((item) => item.status === 'ready').length;
    await saveBackendState(state);
    return { memoryId: `e2e-memory-${candidate.id}` } as T;
  }
  if (functionName === 'complete-gallery-import-run') { if (state.run) state.run.status = 'completed'; await saveBackendState(state); return { completed: true } as T; }
  if (functionName === 'cancel-gallery-import-run') { if (state.run) state.run.status = 'cancelled'; await saveBackendState(state); return { cancelled: true } as T; }
  if (functionName === 'get-gallery-caption-settings') return state.captions as T;
  if (functionName === 'update-gallery-caption-settings') {
    state.captions = { language: bodyString(body, 'language'), instructions: bodyString(body, 'instructions'), updatedAt: new Date().toISOString() };
    await saveBackendState(state);
    return state.captions as T;
  }
  throw new Error(`Unsupported gallery E2E endpoint: ${functionName}`);
}
