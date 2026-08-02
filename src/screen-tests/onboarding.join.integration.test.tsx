// See no-family.test.tsx for why screen tests live outside app/.
//
// Covers WP4's join path (J1-J5, docs/plans/onboarding-implementation.md):
// code entry -> family-found preview -> display name -> email OTP -> the
// approval-wait screen. Every pre-auth network boundary (ensureAnonymousSession,
// previewFamilyInvite, the join draft) and post-auth boundary (useAuth,
// redeemFamilyInvite, updateUserProfile, useFamily, useRedeemedInviteStatus)
// is mocked; the pure helpers (normalizeInviteCode, formatInviteCodeInput,
// isValidInviteCodeShape, pickNewlyJoinedFamilyId) run for real.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import JoinCodeScreen from '../../app/(onboarding)/join/code';
import JoinEmailScreen from '../../app/(onboarding)/join/email';
import JoinFoundScreen from '../../app/(onboarding)/join/found';
import JoinNameScreen from '../../app/(onboarding)/join/name';
import JoinWaitingScreen from '../../app/(onboarding)/join/waiting';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useRedeemedInviteStatus } from '@/hooks/useRedeemedInviteStatus';
import { discardAnonymousSession, ensureAnonymousSession } from '@/lib/anonymous-session';
import {
  onboardingJoinCodeRoute,
  onboardingJoinEmailRoute,
  onboardingJoinFoundRoute,
  onboardingJoinNameRoute,
  onboardingJoinWaitingRoute,
} from '@/lib/onboarding-routes';
import { noFamilyRoute, timelineRoute } from '@/lib/routes';
import { trackEvent } from '@/services/analytics';
import { redeemFamilyInvite } from '@/services/invites';
import { clearJoinDraft, getJoinDraft, patchJoinDraft, previewFamilyInvite } from '@/services/onboarding-join';
import { updateUserProfile } from '@/services/user-profile';
import { clearPendingInviteCode, getPendingInviteCode, setPendingInviteCode } from '@/utils/pending-invite-code';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
  },
}));

jest.mock('@/utils/pending-invite-code', () => ({
  getPendingInviteCode: jest.fn(),
  setPendingInviteCode: jest.fn().mockResolvedValue(undefined),
  clearPendingInviteCode: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/anonymous-session', () => ({
  ensureAnonymousSession: jest.fn(),
  discardAnonymousSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/onboarding-join', () => ({
  previewFamilyInvite: jest.fn(),
  getJoinDraft: jest.fn(),
  patchJoinDraft: jest.fn().mockResolvedValue(undefined),
  clearJoinDraft: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/invites', () => ({
  redeemFamilyInvite: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('@/services/user-profile', () => ({
  updateUserProfile: jest.fn().mockResolvedValue({ data: null, error: null }),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/useUserProfile', () => ({
  userProfileQueryKey: ['user-profile'],
}));

jest.mock('@/hooks/useRedeemedInviteStatus', () => ({
  useRedeemedInviteStatus: jest.fn(),
}));

const mockedGetPendingInviteCode = getPendingInviteCode as jest.MockedFunction<typeof getPendingInviteCode>;
const mockedSetPendingInviteCode = setPendingInviteCode as jest.MockedFunction<typeof setPendingInviteCode>;
const mockedClearPendingInviteCode = clearPendingInviteCode as jest.MockedFunction<typeof clearPendingInviteCode>;
const mockedEnsureAnonymousSession = ensureAnonymousSession as jest.MockedFunction<typeof ensureAnonymousSession>;
const mockedDiscardAnonymousSession = discardAnonymousSession as jest.MockedFunction<typeof discardAnonymousSession>;
const mockedPreviewFamilyInvite = previewFamilyInvite as jest.MockedFunction<typeof previewFamilyInvite>;
const mockedGetJoinDraft = getJoinDraft as jest.MockedFunction<typeof getJoinDraft>;
const mockedPatchJoinDraft = patchJoinDraft as jest.MockedFunction<typeof patchJoinDraft>;
const mockedClearJoinDraft = clearJoinDraft as jest.MockedFunction<typeof clearJoinDraft>;
const mockedRedeemFamilyInvite = redeemFamilyInvite as jest.MockedFunction<typeof redeemFamilyInvite>;
const mockedUpdateUserProfile = updateUserProfile as jest.MockedFunction<typeof updateUserProfile>;
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseRedeemedInviteStatus = useRedeemedInviteStatus as jest.MockedFunction<typeof useRedeemedInviteStatus>;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

function renderScreen(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {ui}
    </SafeAreaProvider>,
  );
}

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return renderScreen(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function authState(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    session: null,
    user: null,
    isLoading: false,
    requestSignInOtp: jest.fn(),
    requestSignUpOtp: jest.fn().mockResolvedValue({ error: null }),
    verifyOtp: jest.fn().mockResolvedValue({ error: null }),
    signInWithPassword: jest.fn(),
    signOut: jest.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useAuth>;
}

function familyState(overrides: Partial<ReturnType<typeof useFamily>> = {}) {
  return {
    family: null,
    familyId: null,
    role: null,
    memberships: [],
    isLoading: false,
    setActiveFamily: jest.fn().mockResolvedValue(undefined),
    refetchMemberships: jest.fn().mockResolvedValue([]),
    justLostAccess: false,
    ...overrides,
  } as unknown as ReturnType<typeof useFamily>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetPendingInviteCode.mockResolvedValue(null);
  mockedGetJoinDraft.mockResolvedValue({});
  mockedUseAuth.mockReturnValue(authState());
  mockedUseFamily.mockReturnValue(familyState());
});

describe('JoinCodeScreen (J1)', () => {
  it('prefills from the stored pendingInviteCode without clearing it', async () => {
    mockedGetPendingInviteCode.mockResolvedValue('sunny-tiger-lake');

    const { getByTestId } = renderScreen(<JoinCodeScreen />);

    await waitFor(() => {
      expect(getByTestId('onb-join-code-input').props.value).toBe('sunny-tiger-lake');
    });
  });

  it('shows an error and does not navigate for an invalid code shape', () => {
    const { getByTestId, queryByText } = renderScreen(<JoinCodeScreen />);

    fireEvent.changeText(getByTestId('onb-join-code-input'), 'sunny-tiger');
    fireEvent.press(getByTestId('onb-join-code-submit-button'));

    expect(queryByText('Enter the 3-word code, like sunny-tiger-lake.')).toBeTruthy();
    expect(mockedSetPendingInviteCode).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('normalizes, stores the code, and navigates to J2 for a valid code', () => {
    const { getByTestId } = renderScreen(<JoinCodeScreen />);

    fireEvent.changeText(getByTestId('onb-join-code-input'), '  SUNNY  Tiger--LAKE ');
    fireEvent.press(getByTestId('onb-join-code-submit-button'));

    expect(mockedSetPendingInviteCode).toHaveBeenCalledWith('sunny-tiger-lake');
    expect(router.push).toHaveBeenCalledWith(onboardingJoinFoundRoute);
  });
});

describe('JoinFoundScreen (J2)', () => {
  beforeEach(() => {
    mockedGetPendingInviteCode.mockResolvedValue('sunny-tiger-lake');
    mockedEnsureAnonymousSession.mockResolvedValue({ error: null });
  });

  it('shows the family + inviter name, and confirming stores the inviter name and navigates to J3', async () => {
    mockedPreviewFamilyInvite.mockResolvedValue({
      data: { familyName: "Rivera Family", inviterName: 'Sam' },
      error: null,
    });

    const { getByTestId, findByText } = renderScreen(<JoinFoundScreen />);

    expect(await findByText('Join Rivera Family?')).toBeTruthy();
    expect(await findByText("Sam invited you to see and share the family's memories.")).toBeTruthy();

    fireEvent.press(getByTestId('onb-join-found-confirm-button'));

    expect(mockedPatchJoinDraft).toHaveBeenCalledWith({ inviterName: 'Sam' });
    expect(router.push).toHaveBeenCalledWith(onboardingJoinNameRoute);
  });

  it('falls back to a generic confirm state when the anonymous session fails, and still lets the user continue', async () => {
    mockedEnsureAnonymousSession.mockResolvedValue({ error: { message: 'anonymous sign-ins disabled' } });

    const { getByTestId, findByText } = renderScreen(<JoinFoundScreen />);

    expect(await findByText('Join this family?')).toBeTruthy();

    fireEvent.press(getByTestId('onb-join-found-confirm-button'));

    expect(router.push).toHaveBeenCalledWith(onboardingJoinNameRoute);
    expect(mockedPreviewFamilyInvite).not.toHaveBeenCalled();
  });

  it('falls back to a generic confirm state when the preview lookup itself errors', async () => {
    mockedPreviewFamilyInvite.mockResolvedValue({
      data: null,
      error: { message: 'That invite code is invalid or has expired.', code: 'invalid_code' },
    });

    const { findByText } = renderScreen(<JoinFoundScreen />);

    expect(await findByText('Join this family?')).toBeTruthy();
  });

  it('re-enter code replaces to J1', async () => {
    mockedPreviewFamilyInvite.mockResolvedValue({
      data: { familyName: "Rivera Family", inviterName: 'Sam' },
      error: null,
    });

    const { getByTestId } = renderScreen(<JoinFoundScreen />);

    await waitFor(() => expect(getByTestId('onb-join-found-reenter-link')).toBeTruthy());
    fireEvent.press(getByTestId('onb-join-found-reenter-link'));

    expect(router.replace).toHaveBeenCalledWith(onboardingJoinCodeRoute);
  });

  it('shows a fallback with no network calls when there is no pending code at all', async () => {
    mockedGetPendingInviteCode.mockResolvedValue(null);

    const { findByText } = renderScreen(<JoinFoundScreen />);

    expect(await findByText("We couldn't find your invite code.")).toBeTruthy();
    expect(mockedEnsureAnonymousSession).not.toHaveBeenCalled();
    expect(mockedPreviewFamilyInvite).not.toHaveBeenCalled();
  });
});

describe('JoinNameScreen (J3)', () => {
  it('prefills from the stored join draft', async () => {
    mockedGetJoinDraft.mockResolvedValue({ displayName: 'Grandma Ana' });

    const { getByTestId } = renderScreen(<JoinNameScreen />);

    await waitFor(() => {
      expect(getByTestId('onb-join-name-input').props.value).toBe('Grandma Ana');
    });
  });

  it('disables the CTA until non-empty, and submitting stores the trimmed name + navigates to J4', () => {
    const { getByTestId } = renderScreen(<JoinNameScreen />);

    expect(getByTestId('onb-join-name-submit-button').props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(getByTestId('onb-join-name-input'), '  Grandma Ana  ');
    expect(getByTestId('onb-join-name-submit-button').props.accessibilityState.disabled).toBe(false);

    fireEvent.press(getByTestId('onb-join-name-submit-button'));

    expect(mockedPatchJoinDraft).toHaveBeenCalledWith({ displayName: 'Grandma Ana' });
    expect(router.push).toHaveBeenCalledWith(onboardingJoinEmailRoute);
  });
});

describe('JoinEmailScreen (J4)', () => {
  beforeEach(() => {
    mockedGetJoinDraft.mockResolvedValue({ displayName: 'Grandma Ana' });
    mockedGetPendingInviteCode.mockResolvedValue('sunny-tiger-lake');
  });

  it('sends the code: discards the anonymous session and requests a signup OTP with the stored display name', async () => {
    const requestSignUpOtp = jest.fn().mockResolvedValue({ error: null });
    mockedUseAuth.mockReturnValue(authState({ requestSignUpOtp }));

    const { getByTestId, findByTestId } = renderScreen(<JoinEmailScreen />);

    await findByTestId('onb-join-email-input');
    fireEvent.changeText(getByTestId('onb-join-email-input'), 'ana@example.com');
    fireEvent.press(getByTestId('onb-join-email-send-button'));

    await findByTestId('onb-join-email-code-input');

    const codeInput = getByTestId('onb-join-email-code-input');
    expect(codeInput.props.accessibilityLabel).toBe('Verification code');
    expect(codeInput.props.cursorColor).toBe('transparent');
    // opacity: 0 alongside color: 'transparent' -- color alone does not
    // reliably hide TextInput text on Android (a stray duplicate of the
    // typed code was visible next to the boxes on a real device).
    expect(codeInput.props.style).toEqual(expect.objectContaining({ color: 'transparent', opacity: 0 }));

    expect(requestSignUpOtp).toHaveBeenCalledWith({ name: 'Grandma Ana', email: 'ana@example.com' });
    expect(mockedDiscardAnonymousSession).toHaveBeenCalled();
  });

  it('auto-verifies a 6-digit code, applies the display name, redeems the invite, and navigates to the waiting screen', async () => {
    const requestSignUpOtp = jest.fn().mockResolvedValue({ error: null });
    const verifyOtp = jest.fn().mockResolvedValue({ error: null });
    mockedUseAuth.mockReturnValue(authState({ requestSignUpOtp, verifyOtp }));
    mockedRedeemFamilyInvite.mockResolvedValue({
      data: { familyName: 'Rivera Family', role: 'viewer', familyId: 'family-rivera' },
      error: null,
    });

    const { getByTestId, findByTestId } = renderScreen(<JoinEmailScreen />);

    await findByTestId('onb-join-email-input');
    fireEvent.changeText(getByTestId('onb-join-email-input'), 'ana@example.com');
    fireEvent.press(getByTestId('onb-join-email-send-button'));

    await findByTestId('onb-join-email-code-input');
    fireEvent.changeText(getByTestId('onb-join-email-code-input'), '123456');

    await waitFor(() => {
      expect(verifyOtp).toHaveBeenCalledWith({ email: 'ana@example.com', token: '123456' });
    });

    await waitFor(() => {
      expect(mockedUpdateUserProfile).toHaveBeenCalledWith({ name: 'Grandma Ana' });
    });
    await waitFor(() => {
      expect(mockedRedeemFamilyInvite).toHaveBeenCalledWith('sunny-tiger-lake');
    });
    await waitFor(() => {
      expect(mockedClearPendingInviteCode).toHaveBeenCalled();
      expect(mockedClearJoinDraft).toHaveBeenCalled();
    });
    expect(router.replace).toHaveBeenCalledWith(onboardingJoinWaitingRoute);
    // invite_redeemed (docs/plans/analytics-implementation.md WP2) -- fires
    // exactly once on redeem success, carrying only the UUID join key.
    expect(mockedTrackEvent).toHaveBeenCalledWith('invite_redeemed', { family_id: 'family-rivera' });
    expect(mockedTrackEvent).toHaveBeenCalledTimes(1);
  });

  it('does not fire invite_redeemed when the redemption fails', async () => {
    const verifyOtp = jest.fn().mockResolvedValue({ error: null });
    mockedUseAuth.mockReturnValue(authState({ verifyOtp }));
    mockedRedeemFamilyInvite.mockResolvedValue({
      data: null,
      error: { message: 'That invite code is invalid or has expired.', code: 'invalid_code' },
    });

    const { getByTestId, findByTestId, findByText } = renderScreen(<JoinEmailScreen />);

    await findByTestId('onb-join-email-input');
    fireEvent.changeText(getByTestId('onb-join-email-input'), 'ana@example.com');
    fireEvent.press(getByTestId('onb-join-email-send-button'));

    await findByTestId('onb-join-email-code-input');
    fireEvent.changeText(getByTestId('onb-join-email-code-input'), '123456');

    expect(await findByText('That invite code is invalid or has expired.')).toBeTruthy();
    expect(mockedTrackEvent).not.toHaveBeenCalledWith('invite_redeemed', expect.anything());
  });

  it('a definitive redeem failure clears the pending code and offers to enter a different code', async () => {
    const verifyOtp = jest.fn().mockResolvedValue({ error: null });
    mockedUseAuth.mockReturnValue(authState({ verifyOtp }));
    mockedRedeemFamilyInvite.mockResolvedValue({
      data: null,
      error: { message: 'That invite code is invalid or has expired.', code: 'invalid_code' },
    });

    const { getByTestId, findByTestId, findByText } = renderScreen(<JoinEmailScreen />);

    await findByTestId('onb-join-email-input');
    fireEvent.changeText(getByTestId('onb-join-email-input'), 'ana@example.com');
    fireEvent.press(getByTestId('onb-join-email-send-button'));

    await findByTestId('onb-join-email-code-input');
    fireEvent.changeText(getByTestId('onb-join-email-code-input'), '123456');

    expect(await findByText('That invite code is invalid or has expired.')).toBeTruthy();
    expect(mockedClearPendingInviteCode).toHaveBeenCalled();

    fireEvent.press(await findByTestId('onb-join-email-reenter-code-button'));
    expect(router.replace).toHaveBeenCalledWith(onboardingJoinCodeRoute);
  });

  it('skips straight to finishing when a real (non-anonymous) session already exists on mount', async () => {
    mockedUseAuth.mockReturnValue(
      authState({ session: { user: { id: 'u1', is_anonymous: false } } as never }),
    );
    mockedRedeemFamilyInvite.mockResolvedValue({
      data: { familyName: 'Rivera Family', role: 'viewer', familyId: 'family-rivera' },
      error: null,
    });

    const { queryByTestId } = renderScreen(<JoinEmailScreen />);

    expect(queryByTestId('onb-join-email-input')).toBeNull();

    await waitFor(() => {
      expect(mockedRedeemFamilyInvite).toHaveBeenCalledWith('sunny-tiger-lake');
    });
    expect(router.replace).toHaveBeenCalledWith(onboardingJoinWaitingRoute);
    expect(mockedTrackEvent).toHaveBeenCalledWith('invite_redeemed', { family_id: 'family-rivera' });
  });
});

describe('JoinWaitingScreen (J5)', () => {
  it('shows the waiting copy personalized with the stored inviter name, with a plain (non-tappable) reassurance line', async () => {
    mockedGetJoinDraft.mockResolvedValue({ inviterName: 'Sam' });
    mockedGetPendingInviteCode.mockResolvedValue(null);
    mockedUseRedeemedInviteStatus.mockReturnValue({
      outcome: { kind: 'waiting', familyName: 'Rivera Family' },
      isLoading: false,
      isError: false,
    });

    const { findByText, getByTestId } = renderWithQueryClient(<JoinWaitingScreen />);

    expect(await findByText('One sec. Sam just needs to wave you in.')).toBeTruthy();

    const reassurance = getByTestId('onb-join-waiting-nudge-reassurance');
    expect(reassurance).toBeTruthy();
    // Plain informational text, not a dead tap target -- no accessibilityRole
    // "button" and no onPress (see WP4 review: a link-styled element that
    // silently does nothing reads as broken on a screen that may sit for
    // hours).
    expect(reassurance.props.accessibilityRole).not.toBe('button');
    expect(reassurance.props.onPress).toBeUndefined();
  });

  it('bounces to J2 when a pending code is still stored and there is no redemption on record yet', async () => {
    mockedGetPendingInviteCode.mockResolvedValue('sunny-tiger-lake');
    mockedUseRedeemedInviteStatus.mockReturnValue({
      outcome: { kind: 'unavailable' },
      isLoading: false,
      isError: false,
    });

    renderWithQueryClient(<JoinWaitingScreen />);

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(onboardingJoinFoundRoute);
    });
  });

  it('shows the terminal unavailable state (no bounce) when there is no pending code stored', async () => {
    mockedGetPendingInviteCode.mockResolvedValue(null);
    mockedUseRedeemedInviteStatus.mockReturnValue({
      outcome: { kind: 'unavailable' },
      isLoading: false,
      isError: false,
    });
    mockedUseFamily.mockReturnValue(familyState({ familyId: null }));

    const { findByTestId, getByTestId } = renderWithQueryClient(<JoinWaitingScreen />);

    expect(await findByTestId('onb-join-waiting-unavailable')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalledWith(onboardingJoinFoundRoute);

    fireEvent.press(getByTestId('onb-join-waiting-unavailable-button'));
    expect(router.replace).toHaveBeenCalledWith(noFamilyRoute);
  });

  it('on approval, refetches memberships before setting the active family, then routes to the timeline', async () => {
    mockedGetPendingInviteCode.mockResolvedValue(null);
    const refetchMemberships = jest
      .fn()
      .mockResolvedValue([{ id: 'm1', familyId: 'family-new', role: 'viewer', name: 'Rivera Family' }]);
    const setActiveFamily = jest.fn().mockResolvedValue(undefined);
    mockedUseFamily.mockReturnValue(
      familyState({ memberships: [], refetchMemberships, setActiveFamily }),
    );
    mockedUseRedeemedInviteStatus.mockReturnValue({
      outcome: { kind: 'approved', familyName: 'Rivera Family' },
      isLoading: false,
      isError: false,
    });

    renderWithQueryClient(<JoinWaitingScreen />);

    await waitFor(() => {
      expect(refetchMemberships).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(setActiveFamily).toHaveBeenCalledWith('family-new');
    });
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(timelineRoute);
    });

    // Refetch must be called (and its result used to resolve the new family)
    // strictly before setActiveFamily -- the race app/(app)/sharing/waiting.tsx
    // guards against.
    const refetchOrder = refetchMemberships.mock.invocationCallOrder[0];
    const setActiveOrder = setActiveFamily.mock.invocationCallOrder[0];
    expect(refetchOrder).toBeLessThan(setActiveOrder);
  });

  it('shows the rejected state', async () => {
    mockedGetPendingInviteCode.mockResolvedValue(null);
    mockedUseRedeemedInviteStatus.mockReturnValue({
      outcome: { kind: 'rejected', familyName: 'Rivera Family' },
      isLoading: false,
      isError: false,
    });

    const { findByTestId } = renderWithQueryClient(<JoinWaitingScreen />);

    expect(await findByTestId('onb-join-waiting-rejected')).toBeTruthy();
  });
});
