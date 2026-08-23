import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useGalleryCaptionSettings, useGalleryImport } from '@/hooks/useGalleryImport';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  createGalleryImportRun,
  getGalleryCaptionSettings,
  updateGalleryCaptionSettings,
} from '@/services/gallery-import';

jest.mock('@/utils/gallery-import-flags', () => ({ isGalleryImportFeatureEnabled: true }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/services/gallery-import', () => ({
  createGalleryImportRun: jest.fn(),
  getGalleryCaptionSettings: jest.fn(),
  updateGalleryCaptionSettings: jest.fn(),
  getGalleryImportRun: jest.fn(),
}));
// The driver module transitively pulls in gallery-import-runner ->
// gallery-import-preview -> gallery-import-scanner -> the real (native)
// expo-media-library, which this suite has no reason to load -- mock the
// driver's surface directly, same as other gallery-import test files mock
// the runner/scanner modules they don't otherwise need.
jest.mock('@/services/gallery-import-driver', () => ({
  getGalleryImportDriverState: jest.fn(() => ({ phase: 'idle', runId: null, pausedUntil: null, lastError: null, isActive: false })),
  subscribeGalleryImportDriver: jest.fn(() => () => undefined),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCreateRun = createGalleryImportRun as jest.MockedFunction<typeof createGalleryImportRun>;
const mockedGetSettings = getGalleryCaptionSettings as jest.MockedFunction<typeof getGalleryCaptionSettings>;
const mockedUpdateSettings = updateGalleryCaptionSettings as jest.MockedFunction<typeof updateGalleryCaptionSettings>;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('gallery import hooks integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (jest.requireMock('@/utils/gallery-import-flags') as { isGalleryImportFeatureEnabled: boolean })
      .isGalleryImportFeatureEnabled = true;
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
  });

  it('keeps a newly-created device-bound run in the scoped cache', async () => {
    mockedCreateRun.mockResolvedValue({
      data: {
        run: { id: 'run-1', familyId: 'family-1', status: 'scanning', reviewExpiresAt: null, limits: {} },
        runCapability: 'local-only',
      },
      error: null,
    });
    const { result } = renderHook(() => useGalleryImport(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.createRun({ consentVersion: 'consent-v1', permissionMode: 'limited' });
    });
    await waitFor(() => expect(result.current.run?.id).toBe('run-1'));
    expect(mockedCreateRun).toHaveBeenCalledWith({ familyId: 'family-1', algorithmVersion: 'gallery-v1', consentVersion: 'consent-v1', permissionMode: 'limited' });
  });

  it('loads and saves owner caption settings through its family-scoped query', async () => {
    mockedGetSettings.mockResolvedValue({
      data: { language: 'en-US', instructions: '', updatedAt: null }, error: null,
    });
    mockedUpdateSettings.mockResolvedValue({
      data: { language: 'pt-BR', instructions: 'Gentle.', updatedAt: null }, error: null,
    });
    const { result } = renderHook(() => useGalleryCaptionSettings(), { wrapper });
    await waitFor(() => expect(result.current.settings?.language).toBe('en-US'));
    await act(async () => {
      await result.current.save({ language: 'pt-BR', instructions: 'Gentle.' });
    });
    await waitFor(() => expect(result.current.settings?.language).toBe('pt-BR'));
    expect(mockedUpdateSettings).toHaveBeenCalledWith({
      familyId: 'family-1', language: 'pt-BR', instructions: 'Gentle.',
    });
  });

  it('never exposes owner settings to a viewer or when no user is signed in', () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as never);
    const viewer = renderHook(() => useGalleryCaptionSettings(), { wrapper });
    expect(viewer.result.current.settings).toBeNull();
    expect(mockedGetSettings).not.toHaveBeenCalled();
    viewer.unmount();

    mockedUseAuth.mockReturnValue({ user: null } as never);
    const signedOut = renderHook(() => useGalleryCaptionSettings(), { wrapper });
    expect(signedOut.result.current.settings).toBeNull();
    expect(mockedGetSettings).not.toHaveBeenCalled();
  });

  it('fails closed for mutations when the rollout flag is disabled', async () => {
    (jest.requireMock('@/utils/gallery-import-flags') as { isGalleryImportFeatureEnabled: boolean })
      .isGalleryImportFeatureEnabled = false;
    const { result } = renderHook(() => useGalleryImport(), { wrapper });
    await act(async () => {
      await expect(result.current.createRun({ consentVersion: 'consent-v1', permissionMode: 'full' })).rejects.toThrow('not available');
    });
    expect(mockedCreateRun).not.toHaveBeenCalled();
  });
});
