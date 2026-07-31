// Regression test for a real device bug: a returning owner (docs/features/
// onboarding.md decision 18 -- someone who habit-tapped through onboarding
// again but already owns a family) who captured a photo/video memory during
// onboarding hit "You must be signed in to save a memory" immediately after
// a *successful* OTP verify, with "Try again" unable to recover.
//
// Confirmed root cause (by tracing, then proven by this test -- not a
// guess): S12B (code.tsx)'s finishAfterCommit/handleVerify async chain is
// created on the render right before the OTP code is submitted --
// necessarily pre-auth, since submitting the code is what triggers
// verifyOtp(). A plain destructured `enqueue` (from
// usePendingMemoryUploads()) stays bound to that pre-auth (user: null)
// snapshot for the rest of that one call, no matter how many renders
// happen afterward -- ordinary React context propagation
// (AuthProvider -> PendingMemoryUploadsProvider) updates the *next* render,
// never an already-created closure's already-destructured local. A second,
// compounding problem: even a freshly-read `enqueue` still reads
// FamilyProvider's `familyId`, which has no way to know about a family
// commitOnboarding just created/resolved until the caller's own
// membership-query invalidation resolves -- guaranteed stale for a
// brand-new family, racy for a returning owner's already-existing one.
//
// Verified via node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:
// verifyOtp() calls `await this._saveSession(session)` and
// `await this._notifyAllSubscribers('SIGNED_IN', session)` *before*
// returning -- so a real OTP verify really does flip auth state mid-call,
// exactly the shape this test's mocked supabase.auth.verifyOtp reproduces
// below.
//
// This suite drives the REAL AuthProvider, FamilyProvider,
// PendingMemoryUploadsProvider, OnboardingFlowProvider, and the REAL
// code.tsx screen -- mocking only the Supabase-backed service/network
// boundary they ultimately call. Mocking useAuth()/usePendingMemoryUploads()
// directly (as onboarding.code.integration.test.tsx does for its own,
// narrower purpose) cannot reproduce this bug at all: a statically-mocked
// user/session never actually *changes* mid-call, which is exactly the
// hook-level mocking that hid this bug the first time (see
// onboarding.post-commit-real-data.integration.test.tsx's header comment
// for the same lesson applied to a different bug).
import { act, fireEvent, render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingCodeScreen from '../../app/(onboarding)/code';
import { AuthProvider } from '@/hooks/use-auth';
import { FamilyProvider } from '@/hooks/use-family';
import { useMemoriesRealtime } from '@/hooks/useMemoriesRealtime';
import { OnboardingFlowProvider, useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { PendingMemoryUploadsProvider } from '@/hooks/use-pending-memory-uploads';
import { timelineRoute } from '@/lib/routes';
import { supabase } from '@/lib/supabase';
import { createFamily, fetchMyFamilyMemberships } from '@/services/family';
import { createFamilyMember, fetchFamilyMembers } from '@/services/family-members';
import { createMemory, runMediaPhotoEmotionAnalysis } from '@/services/memories';
import { postMediaMemory } from '@/services/memory-posting';
import { fetchUserProfile, updateUserProfile } from '@/services/user-profile';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ email: 'sam@rivera.family' })),
}));

// Real AuthProvider pulls this in -- expo-linking is irrelevant to this bug
// and not otherwise mocked by jest-expo for this suite's purposes (same
// boundary src/hooks/use-auth.integration.test.tsx already establishes).
jest.mock('@/hooks/use-auth-url-handler', () => ({
  useAuthUrlHandler: jest.fn(),
}));

jest.mock('@/hooks/useMemoriesRealtime', () => ({
  useMemoriesRealtime: jest.fn(),
}));

// The whole point of this suite: a hand-rolled auth mock that reproduces
// real timing (SIGNED_IN fires from *inside* verifyOtp(), before it
// resolves) rather than a static, unchanging session.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(),
      verifyOtp: jest.fn(),
      getUser: jest.fn(),
      signInWithOtp: jest.fn(),
      signOut: jest.fn(),
    },
  },
}));

jest.mock('@/services/family', () => ({
  createFamily: jest.fn(),
  deleteFamily: jest.fn(),
  fetchMyFamilyMemberships: jest.fn(),
  friendlyFamilyLimitError: jest.fn((message: string) => message),
}));

jest.mock('@/services/family-members', () => ({
  createFamilyMember: jest.fn(),
  fetchFamilyMembers: jest.fn(),
}));

jest.mock('@/services/memories', () => ({
  createMemory: jest.fn(),
  runMediaPhotoEmotionAnalysis: jest.fn(),
}));

// Real usePendingMemoryUploads() pulls this in for the actual upload --
// mock only the network call, not the queue/hook logic this bug lives in.
jest.mock('@/services/memory-posting', () => ({
  postMediaMemory: jest.fn(),
  hasImageMediaAsset: jest.fn((assets: { contentType: string }[]) =>
    assets.some((asset) => !asset.contentType.startsWith('video/')),
  ),
  notifyFamilyActivityFireAndForget: jest.fn(),
}));

jest.mock('@/services/user-profile', () => ({
  fetchUserProfile: jest.fn(),
  updateUserProfile: jest.fn(),
}));

// useUserProfile (mounted for real inside FamilyProvider) also pulls in
// @/services/ai for account-deletion actions and use-pending-memory-
// uploads.tsx pulls it in for link previews -- mock both call sites' needs,
// same as onboarding.post-commit-real-data.integration.test.tsx.
jest.mock('@/services/ai', () => ({
  cancelAccountDeletion: jest.fn(),
  deleteUserAccount: jest.fn(),
  fetchLinkPreviews: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;
const mockedFetchMyFamilyMemberships = fetchMyFamilyMemberships as jest.MockedFunction<typeof fetchMyFamilyMemberships>;
const mockedCreateFamily = createFamily as jest.MockedFunction<typeof createFamily>;
const mockedCreateFamilyMember = createFamilyMember as jest.MockedFunction<typeof createFamilyMember>;
const mockedFetchFamilyMembers = fetchFamilyMembers as jest.MockedFunction<typeof fetchFamilyMembers>;
const mockedCreateMemory = createMemory as jest.MockedFunction<typeof createMemory>;
const mockedRunMediaPhotoEmotionAnalysis = runMediaPhotoEmotionAnalysis as jest.MockedFunction<
  typeof runMediaPhotoEmotionAnalysis
>;
const mockedFetchUserProfile = fetchUserProfile as jest.MockedFunction<typeof fetchUserProfile>;
const mockedUpdateUserProfile = updateUserProfile as jest.MockedFunction<typeof updateUserProfile>;
const mockedPostMediaMemory = postMediaMemory as jest.MockedFunction<typeof postMediaMemory>;
const mockedUseMemoriesRealtime = useMemoriesRealtime as jest.MockedFunction<typeof useMemoriesRealtime>;

const RETURNING_OWNER_USER = { id: 'user-1', is_anonymous: false };
const RETURNING_OWNER_SESSION = { user: RETURNING_OWNER_USER, access_token: 'token-1' };

// A settle-on-demand promise, resolved from inside a mock implementation the
// instant the real event this test cares about happens. Deliberately not
// `waitFor` (a fixed-budget poll): this flow crosses several genuine
// setTimeout(0) macrotask hops (react-query's own notifyManager, plus
// code.tsx's explicit yield before enqueue()), and under heavy parallel
// test-suite load a tuned `waitFor` timeout can miss the outcome even
// though it's already true by the time it gives up (proven: this test
// failed under contention with a 5000ms budget even though it never takes
// more than ~150ms standalone). Awaiting the exact promise instead has no
// wall-clock budget at all -- it resolves whenever the event actually
// happens, no matter how many real ticks that takes.
function createSignal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Providers({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <FamilyProvider>
          <PendingMemoryUploadsProvider>
            <OnboardingFlowProvider>
              <SafeAreaProvider
                initialMetrics={{
                  frame: { height: 844, width: 390, x: 0, y: 0 },
                  insets: { bottom: 34, left: 0, right: 0, top: 47 },
                }}
              >
                {children}
              </SafeAreaProvider>
            </OnboardingFlowProvider>
          </PendingMemoryUploadsProvider>
        </FamilyProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

// Seeds the real onboarding draft the way S9-S11 would have, through the
// real OnboardingFlowProvider -- not a hand-built mock.
function DraftSeed({ onReady }: { onReady: (patch: ReturnType<typeof useOnboardingFlow>['patch']) => void }) {
  const { isHydrated, patch } = useOnboardingFlow();

  useEffect(() => {
    if (isHydrated) {
      onReady(patch);
    }
  }, [isHydrated, onReady, patch]);

  return null;
}

describe('S12B code.tsx -- returning owner with a photo capture (real auth/session timing)', () => {
  let queryClient: QueryClient;
  let authStateCallback: ((event: string, session: unknown) => void | Promise<void>) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    authStateCallback = null;

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });

    // Pre-auth: no session on the device yet (the normal state of S12B
    // before the user has typed/submitted their code).
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    } as never);

    mockedSupabase.auth.onAuthStateChange.mockImplementation((callback: never) => {
      authStateCallback = callback as (event: string, session: unknown) => void | Promise<void>;
      return { data: { subscription: { unsubscribe: jest.fn() } } } as never;
    });

    // The actual bug's mechanism: fire SIGNED_IN from *inside* verifyOtp,
    // before it resolves -- matching real supabase-js (see file header).
    mockedSupabase.auth.verifyOtp.mockImplementation(async () => {
      await authStateCallback?.('SIGNED_IN', RETURNING_OWNER_SESSION);
      return { data: { session: RETURNING_OWNER_SESSION, user: RETURNING_OWNER_USER }, error: null } as never;
    });

    // commitOnboarding's own fresh, network-validated check -- always the
    // real, just-verified user, matching the SIGNED_IN event above.
    mockedSupabase.auth.getUser.mockResolvedValue({
      data: { user: RETURNING_OWNER_USER },
      error: null,
    } as never);

    // The returning owner already has a real family.
    mockedFetchMyFamilyMemberships.mockResolvedValue({
      data: [
        {
          id: 'membership-1',
          family_id: 'family-existing',
          role: 'owner',
          family: { id: 'family-existing', name: 'The Riveras', illustration_style: 'default', deleted_at: null },
        },
      ],
      error: null,
    } as never);
    mockedFetchUserProfile.mockResolvedValue({
      data: { id: 'user-1', active_family_id: 'family-existing', name: 'Sam' } as never,
      error: null,
    });
    mockedUpdateUserProfile.mockResolvedValue({ data: null, error: null });
    mockedFetchFamilyMembers.mockResolvedValue({
      data: [{ id: 'member-real-lila', name: 'Lila' } as never],
      error: null,
    });
    mockedRunMediaPhotoEmotionAnalysis.mockResolvedValue(null);
    mockedPostMediaMemory.mockResolvedValue({ id: 'memory-existing-1' } as never);
    mockedUseMemoriesRealtime.mockReturnValue(undefined);
  });

  it('lands the photo memory in the EXISTING family and routes to the journal -- no "must be signed in" error, no dead-end retry', async () => {
    const draftReady = createSignal<ReturnType<typeof useOnboardingFlow>['patch']>();
    const navigatedToJournal = createSignal();

    (router.replace as jest.Mock).mockImplementation(() => {
      navigatedToJournal.resolve();
    });

    const utils = render(
      <Providers queryClient={queryClient}>
        <DraftSeed onReady={draftReady.resolve} />
        <OnboardingCodeScreen />
      </Providers>,
    );

    let seededPatch!: ReturnType<typeof useOnboardingFlow>['patch'];
    await act(async () => {
      seededPatch = await draftReady.promise;
    });

    // S9-S11 would have populated this: a photo capture, tagged to a kid
    // typed again this session (matched by name against the real roster --
    // see resolveExistingTaggedMemberIds in src/services/onboarding.ts).
    act(() => {
      seededPatch({
        step: 'code',
        kidNames: ['Lila'],
        familyName: "Lila's Family",
        capture: {
          text: 'Garbage truck fan club.',
          mediaUri: 'file:///photo.jpg',
          mediaContentType: 'image/jpeg',
          taggedKidIndexes: [0],
        },
        notificationChoice: 'eve',
      });
    });

    // This is the exact user action that starts the vulnerable async
    // chain -- fired while the screen (and its usePendingMemoryUploads()
    // destructure) is still in its pre-auth render.
    fireEvent.changeText(utils.getByTestId('onboarding-code-input'), '123456');

    // Deterministic: resolves the instant router.replace is actually
    // called, whatever real ticks that takes -- see createSignal's comment.
    await act(async () => {
      await navigatedToJournal.promise;
    });

    expect(router.replace).toHaveBeenCalledWith(timelineRoute);

    // The bug's exact symptom must never appear.
    expect(utils.queryByTestId('onboarding-code-error')).toBeNull();
    expect(utils.queryByTestId('onboarding-code-retry')).toBeNull();

    // Never a second family -- decision 18's hard requirement.
    expect(mockedCreateFamily).not.toHaveBeenCalled();
    expect(mockedCreateFamilyMember).not.toHaveBeenCalled();
    expect(mockedCreateMemory).not.toHaveBeenCalled();

    // The memory actually landed: real (authenticated) user, real
    // (existing) family, tagged to the real Lila row -- not lost, not
    // orphaned pre-auth, not attached to a family React hadn't learned
    // about. No waitFor needed: code.tsx's enqueueRef.current(...) call
    // (which synchronously invokes postMediaMemory, as the first line of
    // usePendingMemoryUploads()'s runUpload) always completes before
    // router.replace(timelineRoute) is reached -- see finishAfterCommit in
    // app/(onboarding)/code.tsx. Already-true assertions, not a race.
    expect(mockedPostMediaMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        familyId: 'family-existing',
        input: expect.objectContaining({
          content: 'Garbage truck fan club.',
          taggedMemberIds: ['member-real-lila'],
        }),
      }),
    );

    await act(async () => {
      utils.unmount();
    });
    queryClient.clear();
  });
});
