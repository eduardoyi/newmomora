import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import Purchases from 'react-native-purchases';

import {
  configureRevenueCat,
  fetchBillingOfferings,
  fetchFamilyBillingStatus,
  hasComplimentaryFamilyAccess,
  logOutRevenueCat,
  purchaseBillingPackage,
  restoreBillingPurchases,
} from './billing';
import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/services/ai';
import { Platform } from 'react-native';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- maintained Jest adapter
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    isConfigured: jest.fn(),
    configure: jest.fn(),
    logIn: jest.fn(),
    logOut: jest.fn(),
    setLogLevel: jest.fn(),
    getOfferings: jest.fn(),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(),
    getCustomerInfo: jest.fn(),
    getAppUserID: jest.fn(),
    purchasePackage: jest.fn(),
    restorePurchases: jest.fn(),
    addCustomerInfoUpdateListener: jest.fn(),
    removeCustomerInfoUpdateListener: jest.fn(),
  },
  LOG_LEVEL: { WARN: 'WARN' },
}));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: jest.fn() },
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
  },
}));

jest.mock('@/services/ai', () => ({
  invokeEdgeFunction: jest.fn(),
}));

const mockPurchases = Purchases as jest.Mocked<typeof Purchases>;
const mockedNetInfo = NetInfo as jest.Mocked<typeof NetInfo>;
const mockedSupabase = supabase as unknown as {
  rpc: jest.Mock;
};
const mockedInvokeEdgeFunction = invokeEdgeFunction as jest.MockedFunction<typeof invokeEdgeFunction>;

const annual = {
  identifier: '$rc_annual',
  packageType: 'ANNUAL',
  product: { identifier: 'momora_annual_v1', priceString: '$99.99', pricePerMonthString: '$8.33' },
} as never;
const monthly = {
  identifier: '$rc_monthly',
  packageType: 'MONTHLY',
  product: { identifier: 'momora_monthly_v1', priceString: '$12.99' },
} as never;

describe('billing service', () => {
  const originalPlatform = Platform.OS;

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    await AsyncStorage.clear();
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'ios_public_key';
    mockedNetInfo.fetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    } as never);
    mockPurchases.isConfigured.mockResolvedValue(false);
    mockPurchases.configure.mockImplementation(jest.fn());
    (mockPurchases.getAppUserID as jest.Mock).mockResolvedValue('current-user');
    mockedInvokeEdgeFunction.mockResolvedValue({ data: {}, error: null });
  });

  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  it('reads the iOS public SDK key through Expo-compatible static env access', async () => {
    await configureRevenueCat('env-key-test-user');

    expect(mockPurchases.configure).toHaveBeenCalledWith({
      apiKey: 'ios_public_key',
      appUserID: 'env-key-test-user',
    });
  });

  it('serializes RevenueCat logout before configuring the next account', async () => {
    await configureRevenueCat('user-a');

    let resolveLogout!: () => void;
    mockPurchases.logOut.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLogout = resolve;
      }),
    );
    mockPurchases.isConfigured.mockResolvedValue(false);

    const logout = logOutRevenueCat();
    const nextConfigure = configureRevenueCat('user-b');

    await Promise.resolve();
    expect(mockPurchases.logOut).toHaveBeenCalledTimes(1);
    expect(mockPurchases.configure).toHaveBeenCalledTimes(1);

    resolveLogout();
    await Promise.all([logout, nextConfigure]);

    expect(mockPurchases.configure).toHaveBeenCalledTimes(2);
    expect(mockPurchases.logOut.mock.invocationCallOrder[0]).toBeLessThan(
      mockPurchases.configure.mock.invocationCallOrder[1],
    );
  });

  it('refuses offerings when RevenueCat is no longer configured for the requested account', async () => {
    await configureRevenueCat('user-a');
    (mockPurchases.getAppUserID as jest.Mock).mockResolvedValue('user-b');

    await expect(fetchBillingOfferings('user-a')).rejects.toMatchObject({ code: 'wrong_account_restore' });
    expect(mockPurchases.getOfferings).not.toHaveBeenCalled();
  });

  it('selects the configured default offering and canonical annual/monthly packages', async () => {
    await configureRevenueCat('user-1');
    mockPurchases.getOfferings.mockResolvedValue({
      current: { identifier: 'default', availablePackages: [monthly, annual] },
      all: { default: { identifier: 'default', availablePackages: [monthly, annual] } },
    } as never);
    mockPurchases.checkTrialOrIntroductoryPriceEligibility.mockResolvedValue({
      momora_annual_v1: { status: 2 },
    } as never);

    const result = await fetchBillingOfferings();

    expect(result?.annual.product.identifier).toBe('momora_annual_v1');
    expect(result?.monthly?.product.identifier).toBe('momora_monthly_v1');
    expect(result?.annualTrialEligibility).toBe('eligible');
  });

  it('does not substitute a package by package type when the allowlisted product is absent', async () => {
    await configureRevenueCat('user-1');
    mockPurchases.getOfferings.mockResolvedValue({
      current: { identifier: 'default', availablePackages: [{ ...annual, product: { ...annual.product, identifier: 'wrong_annual' } }] },
      all: { default: { identifier: 'default', availablePackages: [{ ...annual, product: { ...annual.product, identifier: 'wrong_annual' } }] } },
    } as never);

    await expect(fetchBillingOfferings()).rejects.toThrow('annual Momora subscription is not available');
  });

  it('uses a paid-now fallback when trial eligibility is unknown', async () => {
    await configureRevenueCat('user-1');
    mockPurchases.getOfferings.mockResolvedValue({
      current: { identifier: 'default', availablePackages: [annual] },
      all: { default: { identifier: 'default', availablePackages: [annual] } },
    } as never);
    mockPurchases.checkTrialOrIntroductoryPriceEligibility.mockResolvedValue({
      momora_annual_v1: { status: 0 },
    } as never);

    const result = await fetchBillingOfferings();

    expect(result?.annualTrialEligibility).toBe('unknown');
  });

  it('keeps a successful store charge in confirming state when the server has not reconciled it yet', async () => {
    mockPurchases.purchasePackage.mockResolvedValue({
      customerInfo: { originalAppUserId: 'current-user', entitlements: { active: { momora_plus: {} } } },
    } as never);
    mockedInvokeEdgeFunction.mockResolvedValue({ data: { success: true, active: false }, error: null });

    await expect(purchaseBillingPackage(annual, 'current-user')).rejects.toMatchObject({
      code: 'billing_confirmation_pending',
    });
  });

  it('rejects a restore that belongs to another Momora account', async () => {
    (mockPurchases.getAppUserID as jest.Mock).mockResolvedValue('different-user');
    mockPurchases.restorePurchases.mockResolvedValue({
      originalAppUserId: 'current-user',
      entitlements: { active: { momora_plus: {} } },
    } as never);

    await expect(restoreBillingPurchases('current-user')).rejects.toMatchObject({
      code: 'wrong_account_restore',
    });
    expect(mockedInvokeEdgeFunction).not.toHaveBeenCalled();
  });

  it('uses a short-lived status cache for explicit offline reads', async () => {
    mockedSupabase.rpc.mockResolvedValueOnce({
      data: {
        family_id: 'family-1',
        owner_user_id: 'owner-1',
        has_write_access: true,
        has_ever_had_access: true,
        trial_eligible: false,
        access_reason: 'trial',
        period_type: 'annual',
        expires_at: '2026-08-08T00:00:00.000Z',
        grace_until: null,
        will_renew: true,
        management_url: null,
        enforcement_mode: 'all_families',
        new_family_cutover_at: '2026-08-01T00:00:00.000Z',
        min_supported_app_version: '1.2.0',
      },
      error: null,
    });

    const online = await fetchFamilyBillingStatus('family-1');
    mockedNetInfo.fetch.mockResolvedValue({ isConnected: false, isInternetReachable: false } as never);
    const offline = await fetchFamilyBillingStatus('family-1');

    expect(online.data?.has_write_access).toBe(true);
    expect(offline.data?.has_write_access).toBe(true);
    expect(offline.data?.is_offline).toBe(true);
    expect(mockedSupabase.rpc).toHaveBeenCalledTimes(1);
  });

  it('recognizes an active server-owned complimentary grant', async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: { has_write_access: true, access_reason: 'complimentary' },
      error: null,
    });

    await expect(hasComplimentaryFamilyAccess('family-1')).resolves.toBe(true);
    expect(mockedSupabase.rpc).toHaveBeenCalledWith('get_family_billing_status', {
      p_family_id: 'family-1',
    });
  });

  it('fails closed when complimentary access status cannot be verified', async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: null, error: new Error('offline') });

    await expect(hasComplimentaryFamilyAccess('family-1')).resolves.toBe(false);
  });

  it('fails closed when the complimentary access RPC throws', async () => {
    mockedSupabase.rpc.mockRejectedValue(new Error('network failure'));

    await expect(hasComplimentaryFamilyAccess('family-1')).resolves.toBe(false);
  });
});
