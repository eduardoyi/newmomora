import { act, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';

import { BillingProvider, billingStatusQueryKey, useBilling } from '@/hooks/use-billing';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  addCustomerInfoListener,
  configureRevenueCat,
  fetchBillingOfferings,
  fetchFamilyBillingStatus,
  logOutRevenueCat,
  reconcileBillingAccess,
} from '@/services/billing';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/services/billing', () => ({
  addCustomerInfoListener: jest.fn(),
  configureRevenueCat: jest.fn(),
  fetchBillingOfferings: jest.fn(),
  fetchFamilyBillingStatus: jest.fn(),
  logOutRevenueCat: jest.fn(),
  reconcileBillingAccess: jest.fn(),
  purchaseBillingPackage: jest.fn(),
  restoreBillingPurchases: jest.fn(),
  startPendingOnboardingIllustration: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedConfigureRevenueCat = configureRevenueCat as jest.MockedFunction<typeof configureRevenueCat>;
const mockedFetchBillingOfferings = fetchBillingOfferings as jest.MockedFunction<typeof fetchBillingOfferings>;
const mockedFetchFamilyBillingStatus = fetchFamilyBillingStatus as jest.MockedFunction<typeof fetchFamilyBillingStatus>;
const mockedLogOutRevenueCat = logOutRevenueCat as jest.MockedFunction<typeof logOutRevenueCat>;
const mockedReconcileBillingAccess = reconcileBillingAccess as jest.MockedFunction<typeof reconcileBillingAccess>;
const mockedAddCustomerInfoListener = addCustomerInfoListener as jest.MockedFunction<typeof addCustomerInfoListener>;

function renderProvider(seedCache?: (client: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  seedCache?.(queryClient);
  let latestBilling: ReturnType<typeof useBilling> | null = null;

  function Capture({ onCapture }: { onCapture: (billing: ReturnType<typeof useBilling>) => void }) {
    const billing = useBilling();
    useEffect(() => {
      onCapture(billing);
    }, [billing, onCapture]);
    return null;
  }

  const onCapture = (billing: ReturnType<typeof useBilling>) => {
    latestBilling = billing;
  };

  const tree = (
    <QueryClientProvider client={queryClient}>
      <BillingProvider>
        <Capture onCapture={onCapture} />
      </BillingProvider>
    </QueryClientProvider>
  );

  return { ...render(tree), queryClient, getBilling: () => latestBilling };
}

describe('BillingProvider session transitions', () => {
  let currentUser: { id: string } | null;

  beforeEach(() => {
    jest.clearAllMocks();
    currentUser = { id: 'user-a' };
    mockedUseAuth.mockImplementation(() => ({ user: currentUser } as never));
    mockedUseFamily.mockReturnValue({ familyId: null } as never);
    mockedConfigureRevenueCat.mockResolvedValue({ configured: true });
    mockedFetchBillingOfferings.mockResolvedValue(null);
    mockedFetchFamilyBillingStatus.mockResolvedValue({ data: null, error: null });
    mockedReconcileBillingAccess.mockResolvedValue(false);
    mockedAddCustomerInfoListener.mockReturnValue(jest.fn());
    mockedLogOutRevenueCat.mockResolvedValue(undefined);
  });

  it('waits for RevenueCat logout and reloads offerings for the next signed-in user', async () => {
    let resolveLogout!: () => void;
    mockedLogOutRevenueCat.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLogout = resolve;
      }),
    );

    const screen = renderProvider();

    await waitFor(() => expect(mockedConfigureRevenueCat).toHaveBeenCalledWith('user-a'));
    await waitFor(() => expect(mockedFetchBillingOfferings).toHaveBeenCalledTimes(1));
    expect(mockedFetchBillingOfferings).toHaveBeenCalledWith('user-a');

    currentUser = null;
    await act(async () => {
      screen.rerender(
        <QueryClientProvider client={screen.queryClient}>
          <BillingProvider><BillingProbe /></BillingProvider>
        </QueryClientProvider>,
      );
    });
    expect(mockedLogOutRevenueCat).toHaveBeenCalledTimes(1);

    currentUser = { id: 'user-b' };
    await act(async () => {
      screen.rerender(
        <QueryClientProvider client={screen.queryClient}>
          <BillingProvider><BillingProbe /></BillingProvider>
        </QueryClientProvider>,
      );
    });

    expect(mockedConfigureRevenueCat).not.toHaveBeenCalledWith('user-b');

    resolveLogout();

    await waitFor(() => expect(mockedConfigureRevenueCat).toHaveBeenCalledWith('user-b'));
    await waitFor(() => expect(mockedFetchBillingOfferings).toHaveBeenCalledTimes(2));

    screen.unmount();
    screen.queryClient.clear();
  });

  it('does not fetch same-user offerings until an in-flight logout has finished', async () => {
    let resolveLogout!: () => void;
    mockedLogOutRevenueCat.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLogout = resolve;
      }),
    );

    const screen = renderProvider();

    await waitFor(() => expect(mockedConfigureRevenueCat).toHaveBeenCalledWith('user-a'));
    await waitFor(() => expect(mockedFetchBillingOfferings).toHaveBeenCalledTimes(1));

    currentUser = null;
    await act(async () => {
      screen.rerender(
        <QueryClientProvider client={screen.queryClient}>
          <BillingProvider><BillingProbe /></BillingProvider>
        </QueryClientProvider>,
      );
    });

    currentUser = { id: 'user-a' };
    await act(async () => {
      screen.rerender(
        <QueryClientProvider client={screen.queryClient}>
          <BillingProvider><BillingProbe /></BillingProvider>
        </QueryClientProvider>,
      );
    });

    expect(mockedConfigureRevenueCat).toHaveBeenCalledTimes(1);
    expect(mockedFetchBillingOfferings).toHaveBeenCalledTimes(1);

    resolveLogout();

    await waitFor(() => expect(mockedConfigureRevenueCat).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockedFetchBillingOfferings).toHaveBeenCalledTimes(2));

    screen.unmount();
    screen.queryClient.clear();
  });

  it('does not cache an empty offerings result when a paywall refreshes before RevenueCat is configured', async () => {
    currentUser = null;
    const screen = renderProvider();

    await waitFor(() => expect(screen.getBilling()).not.toBeNull());
    await act(async () => {
      await screen.getBilling()?.refresh();
    });
    expect(mockedFetchBillingOfferings).not.toHaveBeenCalled();

    currentUser = { id: 'user-a' };
    await act(async () => {
      screen.rerender(
        <QueryClientProvider client={screen.queryClient}>
          <BillingProvider><BillingProbe /></BillingProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => expect(mockedConfigureRevenueCat).toHaveBeenCalledWith('user-a'));
    await waitFor(() => expect(mockedFetchBillingOfferings).toHaveBeenCalledTimes(1));

    screen.unmount();
    screen.queryClient.clear();
  });

  // Cold start (docs/features/subscriptions.md "Cold start and persisted
  // status"): the billing status is restored from the persisted cache, but
  // AuthProvider's user is still null on the first render. That must not wipe
  // the restored status; a settled signed-out state still must.
  it('keeps a restored billing status while auth is still loading, and removes it once auth settles signed out', async () => {
    const restoredKey = [...billingStatusQueryKey, 'family-1'];
    const restored = { data: { family_id: 'family-1', has_write_access: true }, error: null };
    let isAuthLoading = true;
    currentUser = null;
    mockedUseAuth.mockImplementation(() => ({ user: currentUser, isLoading: isAuthLoading }) as never);

    // Seeded before mount, like the persisted cache restore that precedes it.
    const screen = renderProvider((client) => client.setQueryData(restoredKey, restored));

    await waitFor(() => expect(mockedLogOutRevenueCat).toHaveBeenCalled());
    expect(screen.queryClient.getQueryData(restoredKey)).toEqual(restored);

    isAuthLoading = false;
    await act(async () => {
      screen.rerender(
        <QueryClientProvider client={screen.queryClient}>
          <BillingProvider><BillingProbe /></BillingProvider>
        </QueryClientProvider>,
      );
    });

    expect(screen.queryClient.getQueryData(restoredKey)).toBeUndefined();

    screen.unmount();
    screen.queryClient.clear();
  });

  it('does not reconfigure RevenueCat when the auth user object is replaced but the user id is unchanged', async () => {
    const screen = renderProvider();
    await waitFor(() => expect(mockedConfigureRevenueCat).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedFetchBillingOfferings).toHaveBeenCalledTimes(1));

    // Provisional -> refreshed session (and every hourly token refresh) hands
    // back a new user object for the same account.
    currentUser = { id: 'user-a' };
    await act(async () => {
      screen.rerender(
        <QueryClientProvider client={screen.queryClient}>
          <BillingProvider><BillingProbe /></BillingProvider>
        </QueryClientProvider>,
      );
    });

    expect(mockedConfigureRevenueCat).toHaveBeenCalledTimes(1);
    expect(mockedLogOutRevenueCat).not.toHaveBeenCalled();

    screen.unmount();
    screen.queryClient.clear();
  });
});

function BillingProbe() {
  useBilling();
  return null;
}
