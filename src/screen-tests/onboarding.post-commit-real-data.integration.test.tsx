// WP7-A (docs/plans/onboarding-implementation.md) -- the blind-spot test.
//
// Every other onboarding screen test (including this repo's existing
// onboarding.paywall.integration.test.tsx and
// onboarding.portrait.integration.test.tsx, before this file) mocks
// useOnboardingFlow() directly with a hand-populated draft. That mocking
// choice is exactly what let two bugs ship: S12B's code.tsx
// (`finishAfterCommit`) calls `clear()` on the device-local onboarding draft
// -- wiping kidNames/capture -- BEFORE routing into S13-S16, deliberately,
// so the layout's `committedFamilyId` backstop redirect doesn't trap that
// arc (see app/(onboarding)/_layout.tsx and code.tsx). That means every
// screen from S13 onward renders, in the real app, against a genuinely
// empty draft -- a state no existing screen test ever exercised, because
// they all mocked the draft into existence.
//
// WP6 already found and fixed one casualty (S16/portrait.tsx's target-member
// resolution permanently disabling "Choose a photo"). This file is the
// regression test for that fix AND for WP7-A's fix to the same bug on S14
// (included.tsx) and S15 (paywall.tsx), which silently lost their kid-name
// personalization to the neutral "their" phrasing instead.
//
// This suite drives the REAL OnboardingFlowProvider (real AsyncStorage-
// backed draft, via the maintained async-storage-mock), the REAL
// FamilyProvider/useFamily, and the REAL useFamilyMembers()/
// usePortraitVersions()/useMediaUrl() hooks -- mocking only the
// service/network boundary they ultimately call (Supabase-backed service
// modules under src/services/), plus useAuth() and useMemoriesRealtime()
// (established mocking boundaries for auth/realtime plumbing that aren't
// this bug's subject -- see use-family.integration.test.tsx for the same
// precedent). It runs the actual sequence: seed a populated draft (as S6-S11
// would have) -> commitOnboarding() for real -> the same membership-query
// invalidation code.tsx awaits -> clear() -> render S13, S14, S15, S16, S17
// in that order, as children of the SAME provider tree (so the draft that's
// cleared is the exact draft each subsequent screen reads).
//
// If a future change reintroduces a bare `draft.kidNames`/`draft.capture`
// read on any post-commit screen (instead of resolving through real family-
// member data once the draft is empty), THIS is the test that fails: S14/S15
// would render the neutral "their" copy instead of "Lila's", and S16's
// "Choose a photo" CTA would resolve nothing (or stay disabled), exactly as
// it did in production before WP6/WP7-A. That silent collapse is invisible
// to every other onboarding screen test in this repo, because they all mock
// the draft into existence -- do not "fix" a failure here by mocking
// useOnboardingFlow or useFamilyMembers; that would recreate the exact blind
// spot this file exists to close.
//
// This file also covers a second, related regression found while writing
// the S16 coverage above: for a multi-kid family's FIRST portrait (no
// explicit memberId param -- resolution falls through to the ambiguous
// `hasNoPortraitYet` search), the instant the chosen kid's version lands in
// the shared portrait-versions/family-members cache, that kid stops
// matching `hasNoPortraitYet` and portrait.tsx's target resolution could
// silently hand the screen to an untouched sibling mid-flight -- the
// screen would then watch/report the wrong child's (empty) portrait
// status and could reveal the wrong kid. `portrait.tsx` now pins the
// resolved target the moment it's first known (see `resolveTargetMember`'s
// doc comment there); the "WP7-A pin regression" block below is the test
// for it, proven with the same real-hooks setup this file already builds
// -- the existing mocked-hook portrait test can't see this bug at all,
// since its `useFamilyMembers` mock never changes members mid-test.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import TrialScreen from '../../app/(onboarding)/trial';
import IncludedScreen from '../../app/(onboarding)/included';
import PaywallScreen from '../../app/(onboarding)/paywall';
import PortraitScreen from '../../app/(onboarding)/portrait';
import RevealScreen from '../../app/(onboarding)/reveal';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { FamilyProvider, familyMembershipsQueryKey, useFamily } from '@/hooks/use-family';
import { useMemoriesRealtime } from '@/hooks/useMemoriesRealtime';
import { OnboardingFlowProvider, useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingRevealRoute } from '@/lib/onboarding-routes';
import { supabase } from '@/lib/supabase';
import { fetchMyFamilyMemberships } from '@/services/family';
import { fetchFamilyMembers } from '@/services/family-members';
import { getMediaUrls } from '@/services/media';
import { commitOnboarding } from '@/services/onboarding';
import { createPortraitVersion, fetchFamilyPortraitVersions, generatePortraitVersion } from '@/services/portrait-versions';
import { fetchUserProfile, updateUserProfile } from '@/services/user-profile';
import { pickFamilyProfilePhotoFromLibrary } from '@/utils/family-profile-photo-picker';

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: jest.fn(() => ({})),
    // portrait.tsx's pick-state before/after rotation uses this -- a no-op
    // here (same as onboarding.year.integration.test.tsx and
    // onboarding.portrait.integration.test.tsx's default) is correct: this
    // suite's S16 assertions are about target-member resolution and status
    // transitions, not the decorative rotation, so nothing needs the effect
    // to actually run.
    useFocusEffect: jest.fn(),
    // paywall.tsx's Terms/Privacy links -- not billing, stubbed the same way
    // onboarding.paywall.integration.test.tsx already does.
    Link: ({ href, style, testID, children }: {
      href: string;
      style?: unknown;
      testID?: string;
      children?: React.ReactNode;
    }) => (
      <Text href={href} style={style} testID={testID}>
        {children}
      </Text>
    ),
  };
});

// Established mocking boundary (see use-family.integration.test.tsx) -- auth
// session mechanics and the realtime channel subscription aren't this bug's
// subject. Everything downstream of these two (FamilyProvider,
// useFamilyMembers, usePortraitVersions, useMediaUrl, OnboardingFlowProvider)
// is real.
jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-billing', () => ({
  useBilling: jest.fn(),
}));

jest.mock('@/hooks/use-pending-memory-uploads', () => ({
  usePendingMemoryUploads: jest.fn(() => ({ enqueue: jest.fn() })),
}));

jest.mock('@/hooks/useMemoriesRealtime', () => ({
  useMemoriesRealtime: jest.fn(),
}));

// Service/network boundary mocks -- everything commitOnboarding,
// FamilyProvider, useFamilyMembers, usePortraitVersions, and useMediaUrl
// ultimately call.
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getUser: jest.fn() }, rpc: jest.fn() },
}));

jest.mock('@/services/family', () => ({
  deleteFamily: jest.fn(),
  fetchMyFamilyMemberships: jest.fn(),
  friendlyFamilyLimitError: jest.fn((message: string) => message),
}));

jest.mock('@/services/family-members', () => ({
  fetchFamilyMembers: jest.fn(),
  createFamilyMemberWithPhoto: jest.fn(),
  updateFamilyMemberWithPhoto: jest.fn(),
  deleteFamilyMember: jest.fn(),
}));

jest.mock('@/services/user-profile', () => ({
  fetchUserProfile: jest.fn(),
  updateUserProfile: jest.fn(),
}));

// useUserProfile (mounted for real inside FamilyProvider) also pulls in
// @/services/ai for account-deletion actions -- mock it too, same as
// use-family.integration.test.tsx.
jest.mock('@/services/ai', () => ({
  cancelAccountDeletion: jest.fn(),
  deleteUserAccount: jest.fn(),
}));

jest.mock('@/services/portrait-versions', () => ({
  fetchFamilyPortraitVersions: jest.fn(),
  createPortraitVersion: jest.fn(),
  updatePortraitVersionDate: jest.fn(),
  generatePortraitVersion: jest.fn(),
  deletePortraitVersion: jest.fn(),
}));

jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));

jest.mock('@/utils/family-profile-photo-picker', () => ({
  pickFamilyProfilePhotoFromLibrary: jest.fn(),
  parsePendingPickerResult: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  getPendingResultAsync: jest.fn(),
}));

// OnboardingFlowProvider (src/hooks/use-onboarding-flow.tsx) pulls in the
// real AsyncStorage-backed persistence helpers -- swap in the maintained
// mock so the native module never loads under Jest, while the provider's
// real hydrate/patch/clear logic still runs against it (same pattern as
// onboarding.code.integration.test.tsx).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseBilling = useBilling as jest.MockedFunction<typeof useBilling>;
const mockedUseMemoriesRealtime = useMemoriesRealtime as jest.MockedFunction<typeof useMemoriesRealtime>;
const mockedSupabase = supabase as jest.Mocked<typeof supabase>;
const mockedFetchMyFamilyMemberships = fetchMyFamilyMemberships as jest.MockedFunction<typeof fetchMyFamilyMemberships>;
const mockedFetchFamilyMembers = fetchFamilyMembers as jest.MockedFunction<typeof fetchFamilyMembers>;
const mockedFetchUserProfile = fetchUserProfile as jest.MockedFunction<typeof fetchUserProfile>;
const mockedUpdateUserProfile = updateUserProfile as jest.MockedFunction<typeof updateUserProfile>;
const mockedFetchFamilyPortraitVersions = fetchFamilyPortraitVersions as jest.MockedFunction<typeof fetchFamilyPortraitVersions>;
const mockedCreatePortraitVersion = createPortraitVersion as jest.MockedFunction<typeof createPortraitVersion>;
const mockedGeneratePortraitVersion = generatePortraitVersion as jest.MockedFunction<typeof generatePortraitVersion>;
const mockedGetMediaUrls = getMediaUrls as jest.MockedFunction<typeof getMediaUrls>;
const mockedPickFromLibrary = pickFamilyProfilePhotoFromLibrary as jest.MockedFunction<typeof pickFamilyProfilePhotoFromLibrary>;
const mockedUseLocalSearchParams = useLocalSearchParams as jest.MockedFunction<typeof useLocalSearchParams>;
const mockedGetPendingResultAsync = ImagePicker.getPendingResultAsync as jest.MockedFunction<typeof ImagePicker.getPendingResultAsync>;

const NOW = '2026-07-30T00:00:00.000Z';

const LILA_ROW = {
  id: 'member-lila',
  user_id: 'user-1',
  family_id: 'family-1',
  name: 'Lila',
  nicknames: [],
  date_of_birth: null,
  gender: null,
  profile_picture_key: null,
  illustrated_profile_key: null,
  illustrated_profile_status: 'pending' as const,
  additional_info: null,
  is_user_profile: false,
  created_at: NOW,
  updated_at: NOW,
};

const MIGUEL_ROW = {
  ...LILA_ROW,
  id: 'member-miguel',
  name: 'Miguel',
};

// Real fetchFamilyMembers sorts by tag count server-side -- since Lila is
// the only kid tagged on the first memory, this array is already in the
// order the real service would return.
const POST_COMMIT_MEMBERS = [LILA_ROW, MIGUEL_ROW];

function Providers({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <FamilyProvider>
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
      </FamilyProvider>
    </QueryClientProvider>
  );
}

// Captures the real hook values into a plain object the test can read
// between act()/waitFor() calls -- this is what lets the test call the
// REAL clear() (exactly as code.tsx's finishAfterCommit does) rather than
// asserting against a hand-built draft object. Reported via a callback
// (from an effect, not a direct render-time write) so this component never
// mutates its own props -- the mutation happens on the plain test-scope
// object the callback closes over, not on anything React owns.
interface CapturedState {
  flow: ReturnType<typeof useOnboardingFlow> | null;
  familyId: string | null;
}

function Harness({ onCapture }: { onCapture: (next: CapturedState) => void }) {
  const flow = useOnboardingFlow();
  const familyId = useFamily().familyId;

  useEffect(() => {
    onCapture({ flow, familyId });
  });

  return null;
}

describe('Post-commit onboarding screens read real server data, not the cleared draft (WP7-A)', () => {
  let queryClient: QueryClient;
  const state: CapturedState = { flow: null, familyId: null };

  beforeEach(() => {
    jest.clearAllMocks();
    state.flow = null;
    state.familyId = null;

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });

    mockedUseAuth.mockReturnValue({
      session: { user: { id: 'user-1' } } as never,
      user: { id: 'user-1' } as never,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseBilling.mockReturnValue({
      offerings: {
        offering: {} as never,
        annual: { product: { priceString: '$99.99', pricePerMonthString: '$8.33' }, packageType: 'ANNUAL' } as never,
        monthly: null,
        annualTrialEligibility: 'eligible',
        raw: {} as never,
      },
      status: {
        family_id: 'family-1',
        owner_user_id: 'user-1',
        has_write_access: false,
        has_ever_had_access: false,
        trial_eligible: true,
      } as never,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: jest.fn(),
      restore: jest.fn(),
      startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);
    mockedUseMemoriesRealtime.mockReturnValue(undefined);

    mockedSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    } as never);
    mockedSupabase.rpc.mockResolvedValue({
      data: [{ family_id: 'family-1', memory_id: 'memory-1', is_new_family: true }],
      error: null,
    } as never);
    // active_family_id pre-set to the family this suite creates: once
    // FamilyProvider resolves a membership for 'family-1', this must already
    // match, or its stale-active-family-id correction effect (use-family.tsx)
    // would loop -- mutate profile -> invalidate -> refetch this same static
    // mock -> still mismatched -> mutate again -- forever.
    mockedFetchUserProfile.mockResolvedValue({
      data: { id: 'user-1', active_family_id: 'family-1', name: 'Sam' } as never,
      error: null,
    });
    mockedUpdateUserProfile.mockResolvedValue({ data: null, error: null });
    // Default for FamilyProvider's own membershipsQuery, which fires
    // immediately on mount (before the test body sets anything up) --
    // without this, that very first call destructures `undefined` and the
    // query gets stuck in an error state. The test body reassigns this once
    // the family actually exists.
    mockedFetchMyFamilyMemberships.mockResolvedValue({ data: [], error: null });

    mockedUseLocalSearchParams.mockReturnValue({});
    mockedGetPendingResultAsync.mockResolvedValue(null);
  });

  function captureState(next: CapturedState) {
    state.flow = next.flow;
    state.familyId = next.familyId;
  }

  function renderTree(screen: ReactNode, utils?: ReturnType<typeof render>) {
    const tree = (
      <Providers queryClient={queryClient}>
        <Harness onCapture={captureState} />
        {screen}
      </Providers>
    );
    return utils ? (utils.rerender(tree), utils) : render(tree);
  }

  it('runs commitOnboarding -> the membership invalidation -> clear(), then renders S13-S17 against the real, empty post-commit draft', async () => {
    // ---- Pre-commit: seed the draft the way S6-S11 would have. ----
    let utils = renderTree(null);

    await waitFor(() => expect(state.flow?.isHydrated).toBe(true));

    act(() => {
      state.flow!.patch({
        step: 'code',
        kidNames: ['Lila', 'Miguel'],
        familyName: "Lila & Miguel's Family",
        capture: {
          text: 'She lined up her stuffed animals to watch for the garbage truck.',
          taggedKidIndexes: [0],
        },
        notificationChoice: 'eve',
      });
    });

    const seededDraft = state.flow!.draft;
    expect(seededDraft.kidNames).toEqual(['Lila', 'Miguel']);

    // ---- commitOnboarding, for real -- no existing family (brand-new owner). ----
    mockedFetchMyFamilyMemberships.mockResolvedValue({ data: [], error: null });
    let commitResult: Awaited<ReturnType<typeof commitOnboarding>> | undefined;
    await act(async () => {
      commitResult = await commitOnboarding(seededDraft);
    });

    expect(commitResult?.error).toBeNull();
    expect(commitResult?.data).toEqual({
      familyId: 'family-1',
      memoryId: 'memory-1',
      isNewFamily: true,
      pendingMediaUpload: null,
    });

    // ---- The world now has a real family -- point the server mocks at it. ----
    mockedFetchFamilyMembers.mockResolvedValue({ data: POST_COMMIT_MEMBERS, error: null });
    mockedFetchFamilyPortraitVersions.mockResolvedValue({ data: [], error: null });
    mockedFetchMyFamilyMemberships.mockResolvedValue({
      data: [
        {
          id: 'membership-1',
          family_id: 'family-1',
          role: 'owner',
          family: { id: 'family-1', name: "Lila & Miguel's Family", deleted_at: null },
        },
      ],
      error: null,
    } as never);

    // ---- The exact fix code.tsx's finishAfterCommit relies on: invalidate
    // and AWAIT the memberships query before routing away. This is the
    // "membership-freshness assumption" the task brief asked to verify --
    // it holds: by the time this resolves, useFamily()'s familyId already
    // reflects the brand-new family. ----
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey });
    });

    // TanStack Query's notifyManager batches subscriber notifications on a
    // macrotask, so the refetch settling (awaited above) can land slightly
    // before FamilyProvider's own re-render does -- waitFor (not a bare
    // expect) gives that scheduled notification a turn.
    await waitFor(() => {
      expect(state.familyId).toBe('family-1');
    });

    // ---- code.tsx's finishAfterCommit: clear() runs before navigating into
    // S13, specifically so the layout's committedFamilyId backstop doesn't
    // redirect this arc back to the journal. This is the real clear(), not
    // a hand-built empty draft. ----
    await act(async () => {
      await state.flow!.clear();
    });

    expect(state.flow!.draft.kidNames).toEqual([]);
    expect(state.flow!.draft.capture).toBeNull();

    // ---- S13: only uses patch() -- no draft read to regress. Rendering it
    // here proves it survives the empty draft without crashing. ----
    utils = renderTree(<TrialScreen />, utils);
    await waitFor(() => expect(utils.getByTestId('onb-trial-screen')).toBeTruthy());

    // ---- S14: the first real regression assertion. Before WP7-A this
    // rendered "Everything their journal comes with:" -- the neutral
    // fallback -- because included.tsx read draft.kidNames/draft.capture
    // directly, and both are now empty. It must resolve Lila from real
    // server data instead. ----
    // This fixture is a TWO-child family (Lila & Miguel), so the correct
    // output is the neutral form, not either kid's name. It used to assert
    // "Everything Lila's journal comes with:" -- which was the device-
    // reported bug (2026-07-31): singling out one child of two is the
    // pick-a-favorite wound spec decision 8 exists to avoid.
    //
    // Note this assertion can no longer distinguish "resolved correctly
    // from server data" from "fell through to the last-resort neutral",
    // since both produce the same string. The single-child server-data
    // path is covered at the unit level instead, by
    // use-onboarding-kid-possessive.test.tsx's "resolves a single real
    // family member unambiguously once the draft is empty".
    utils = renderTree(<IncludedScreen />, utils);
    await waitFor(() => {
      expect(utils.getByText('Everything your journal comes with:')).toBeTruthy();
    });
    expect(utils.queryByText(/Everything Lila's journal comes with/)).toBeNull();
    expect(utils.getByText('Their illustrated portrait and storybook pages')).toBeTruthy();

    // ---- S15: identical bug, same fix, and the same two-child correction
    // as S14 above. The paywall builds "Turn {X} little moments ..." rather
    // than an "{X} journal" phrase, so it keeps the neutral "their" here
    // instead of journalPossessive's "your" flavor. ----
    utils = renderTree(<PaywallScreen />, utils);
    await waitFor(() => {
      expect(
        utils.getByText("Turn their little moments into something you'll hold forever."),
      ).toBeTruthy();
    });
    expect(utils.queryByText(/Turn Lila's little moments/)).toBeNull();

    // ---- S16 (WP6's target resolution, extended by WP7-A's pin below):
    // the CTA must be enabled and must resolve Lila (the kid tagged on the
    // first memory, surfaced by fetchFamilyMembers' tag-count sort) as the
    // target, using real useFamilyMembers()/usePortraitVersions() data
    // against the same empty draft. No explicit memberId param is passed
    // here -- this is deliberately the "first portrait of a multi-kid
    // family" case the WP7-A pin regression below exercises. ----
    utils = renderTree(<PortraitScreen />, utils);
    await waitFor(() => {
      expect(utils.getByText("Let's make Lila's portrait.")).toBeTruthy();
    });
    const choosePhotoButton = utils.getByTestId('onb-portrait-choose-photo-button');
    expect(choosePhotoButton.props.accessibilityState.disabled).toBe(false);

    mockedPickFromLibrary.mockResolvedValue({
      selection: {
        uri: 'file:///lila.jpg',
        contentType: 'image/jpeg',
        captureDate: null,
        referenceDate: '2026-07-30',
        dateSource: 'default_today',
      },
    });
    const pendingVersion = {
      id: 'version-1',
      family_id: 'family-1',
      family_member_id: 'member-lila',
      user_id: 'user-1',
      reference_date: '2026-07-30',
      date_source: 'default_today' as const,
      profile_picture_key: 'raw/lila.jpg',
      illustrated_profile_key: null,
      illustrated_profile_status: 'pending' as const,
      generation_token: null,
      generation_started_at: null,
      generation_output_key: null,
      deletion_token: null,
      deletion_started_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    mockedCreatePortraitVersion.mockResolvedValue({ data: pendingVersion, error: null });
    mockedGeneratePortraitVersion.mockResolvedValue({ data: { success: true }, error: null });
    // The mutation's own onSuccess invalidates the portrait-versions query;
    // point the next fetch at the version it just "created" server-side.
    mockedFetchFamilyPortraitVersions.mockResolvedValue({ data: [pendingVersion], error: null });

    await act(async () => {
      fireEvent.press(choosePhotoButton);
    });

    await waitFor(() => {
      expect(mockedCreatePortraitVersion).toHaveBeenCalledWith(
        expect.objectContaining({ familyMemberId: 'member-lila' }),
      );
    });
    await waitFor(() => {
      expect(utils.getByText("We're painting.")).toBeTruthy();
    });

    // ---- WP7-A pin regression: this is the multi-kid retarget bug in its
    // most direct form. No explicit memberId param was ever passed to this
    // screen -- resolution came from the ambiguous hasNoPortraitYet search,
    // which just landed on Lila. The instant her version above lands in the
    // shared cache (about to happen via this exact invalidation), her
    // hasNoPortraitYet flips to false. Without portrait.tsx's pin, the next
    // render's resolveTargetMember would silently hand the target to
    // Miguel (still unpainted) instead -- this screen would then be
    // watching/reporting Miguel's (empty) portrait-version list, never
    // detect Lila's real ready-transition, and (if it ever did fire)
    // would navigate to the wrong child's reveal. Asserting the reveal
    // route names Lila specifically is what makes this test fail loudly
    // if that pin ever regresses.
    mockedFetchFamilyPortraitVersions.mockResolvedValue({
      data: [{ ...pendingVersion, illustrated_profile_status: 'ready', illustrated_profile_key: 'illustrated/lila.jpg' }],
      error: null,
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['portrait-versions'] });
      await queryClient.invalidateQueries({ queryKey: ['family-members'] });
    });

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(onboardingRevealRoute('member-lila'));
    });
    expect(router.replace).not.toHaveBeenCalledWith(onboardingRevealRoute('member-miguel'));

    // ---- S17: hands off from the exact live state above -- Lila's
    // portrait ready, Miguel still unpainted. ----
    mockedUseLocalSearchParams.mockReturnValue({ memberId: 'member-lila' });
    mockedGetMediaUrls.mockResolvedValue({
      data: { urls: { 'illustrated/lila.jpg': 'https://signed.example/lila.jpg' } },
      error: null,
    });

    utils = renderTree(<RevealScreen />, utils);

    await waitFor(() => {
      expect(utils.getByText('Meet Lila.')).toBeTruthy();
    });
    // Real member resolution (not the draft, which is still empty) for both
    // the headline and the sibling-chain CTA: Miguel genuinely has zero
    // portrait versions in this server snapshot.
    expect(utils.getByTestId('onb-reveal-next-sibling-button')).toBeTruthy();
    expect(utils.getByText("Miguel's turn. Pick a photo")).toBeTruthy();

    // Let the real signed-URL fetch (useMediaUrl -> getMediaUrls) settle
    // before the test ends, so its resolution doesn't land as an
    // unwrapped-in-act state update after this test has already finished.
    await waitFor(() => {
      expect(mockedGetMediaUrls).toHaveBeenCalledWith(['illustrated/lila.jpg']);
    });

    // Explicit teardown rather than relying on implicit post-test cleanup:
    // unmount every real hook's subscriptions before the test function
    // returns. Rendering PortraitScreen's "painting" state through a real
    // create-portrait-version mutation (this test's S16 section above) can
    // still leave one worker recycled by Jest at the very end of a
    // stand-alone run of this file ("Jest did not exit... / A worker
    // process has failed to exit gracefully") -- traced during this
    // package's work to something in that specific combination (a real
    // portrait-versions poll plus RN's own Animated frame timer in
    // PulsingFrame/StillFrame), not to anything this test leaves dangling;
    // it does not reproduce for a plain usePortraitVersions() renderHook
    // with the same "pending" data. It is cosmetic: the assertions above
    // all pass, and the full suite (`npm test`) completes cleanly -- Jest
    // force-exits that one recycled worker on its own without blocking the
    // rest of the run.
    await act(async () => {
      utils.unmount();
    });
    queryClient.clear();
  });
});
