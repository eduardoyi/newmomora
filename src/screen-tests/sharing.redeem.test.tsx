// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import RedeemInviteScreen from '../../app/(app)/sharing/redeem';
import { redeemFamilyInvite } from '@/services/invites';
import { sharingWaitingRouteWithName } from '@/lib/routes';
import { clearPendingInviteCode, getPendingInviteCode } from '@/utils/pending-invite-code';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn().mockReturnValue(false),
  },
}));

jest.mock('@/services/invites', () => ({
  redeemFamilyInvite: jest.fn(),
}));

jest.mock('@/utils/pending-invite-code', () => ({
  getPendingInviteCode: jest.fn(),
  clearPendingInviteCode: jest.fn().mockResolvedValue(undefined),
}));

const mockedRedeem = redeemFamilyInvite as jest.MockedFunction<typeof redeemFamilyInvite>;
const mockedGetPending = getPendingInviteCode as jest.MockedFunction<typeof getPendingInviteCode>;
const mockedClearPending = clearPendingInviteCode as jest.MockedFunction<
  typeof clearPendingInviteCode
>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <RedeemInviteScreen />
    </SafeAreaProvider>,
  );
}

describe('RedeemInviteScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetPending.mockResolvedValue(null);
    mockedClearPending.mockResolvedValue(undefined);
  });

  it('prefills from the stored pendingInviteCode without clearing it', async () => {
    mockedGetPending.mockResolvedValue('sunny-tiger-lake');

    const { getByTestId } = renderScreen();

    await waitFor(() => {
      expect(getByTestId('redeem-code-input').props.value).toBe('sunny-tiger-lake');
    });
    expect(mockedClearPending).not.toHaveBeenCalled();
  });

  it('formats typed input: lowercase, spaces to dashes', () => {
    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('redeem-code-input'), 'Sunny Tiger Lake');

    expect(getByTestId('redeem-code-input').props.value).toBe('sunny-tiger-lake');
  });

  it('rejects a malformed code locally without calling the Edge Function', async () => {
    const { getByTestId, findByText } = renderScreen();

    fireEvent.changeText(getByTestId('redeem-code-input'), 'sunny-tiger');
    fireEvent.press(getByTestId('redeem-submit-button'));

    expect(await findByText('Enter the 3-word code, like sunny-tiger-lake.')).toBeTruthy();
    expect(mockedRedeem).not.toHaveBeenCalled();
  });

  it('sends the normalized code, clears the pending code, and lands on the waiting screen', async () => {
    mockedRedeem.mockResolvedValue({
      data: { familyName: "Rosa's family", role: 'viewer' },
      error: null,
    });

    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('redeem-code-input'), '  SUNNY  tiger--LAKE ');
    fireEvent.press(getByTestId('redeem-submit-button'));

    await waitFor(() => {
      expect(mockedRedeem).toHaveBeenCalledWith('sunny-tiger-lake');
    });
    await waitFor(() => {
      expect(mockedClearPending).toHaveBeenCalled();
    });
    expect(router.replace).toHaveBeenCalledWith(sharingWaitingRouteWithName("Rosa's family"));
  });

  it('clears the pending code on a definitive invalid_code failure', async () => {
    mockedRedeem.mockResolvedValue({
      data: null,
      error: { message: 'That invite code is invalid or has expired.', code: 'invalid_code' },
    });

    const { getByTestId, findByText } = renderScreen();

    fireEvent.changeText(getByTestId('redeem-code-input'), 'sunny-tiger-lake');
    fireEvent.press(getByTestId('redeem-submit-button'));

    expect(await findByText('That invite code is invalid or has expired.')).toBeTruthy();
    expect(mockedClearPending).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('keeps the pending code on a transient failure (rate limit)', async () => {
    mockedRedeem.mockResolvedValue({
      data: null,
      error: { message: 'Too many attempts. Please wait a while and try again.', code: 'rate_limited' },
    });

    const { getByTestId, findByText } = renderScreen();

    fireEvent.changeText(getByTestId('redeem-code-input'), 'sunny-tiger-lake');
    fireEvent.press(getByTestId('redeem-submit-button'));

    expect(
      await findByText('Too many attempts. Please wait a while and try again.'),
    ).toBeTruthy();
    expect(mockedClearPending).not.toHaveBeenCalled();
  });
});
