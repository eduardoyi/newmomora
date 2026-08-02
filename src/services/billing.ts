import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import Purchases, {
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesOfferings,
  type PurchasesPackage,
} from 'react-native-purchases';
import { Platform } from 'react-native';

import {
  BILLING_STATUS_CACHE_TTL_MS,
  MOMORA_ANNUAL_PRODUCT_IDS,
  MOMORA_MONTHLY_PRODUCT_IDS,
  MOMORA_OFFERING_ID,
  type CachedFamilyBillingStatus,
  type FamilyBillingStatus,
  WrongAccountRestoreError,
} from '@/constants/billing';
import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction, type ServiceError } from '@/services/ai';

export interface BillingServiceError extends ServiceError {
  code?: string;
}

export interface BillingConfiguration {
  configured: boolean;
  reason?: 'unsupported_platform' | 'missing_api_key';
}

const cacheKey = (familyId: string) => `momora:billing-status:${familyId}`;
let configuredForUserId: string | null = null;
let configuredKey: string | null = null;
let revenueCatOperationChain: Promise<unknown> = Promise.resolve();

/**
 * RevenueCat's native singleton cannot safely process configure/login/logout
 * transitions concurrently. Keep every identity-sensitive operation in one
 * FIFO so a sign-out cannot race the next user's login or a purchase.
 */
function runRevenueCatOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = revenueCatOperationChain.then(operation, operation);
  revenueCatOperationChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function isNativeStorePlatform(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

function getApiKey(): string | null {
  if (Platform.OS === 'ios') {
    return process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ?? null;
  }
  if (Platform.OS === 'android') {
    return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ?? null;
  }
  return null;
}

function mapError(error: unknown, fallback: string): BillingServiceError {
  if (error instanceof WrongAccountRestoreError) {
    return error;
  }
  if (error instanceof Error) {
    return { message: error.message, code: 'billing_error' };
  }
  return { message: fallback, code: 'billing_error' };
}

async function configureRevenueCatInternal(userId: string, apiKey: string): Promise<BillingConfiguration> {
  if (configuredForUserId === userId && configuredKey === apiKey) {
    return { configured: true };
  }

  const isConfigured = await Purchases.isConfigured().catch(() => false);
  if (isConfigured) {
    if (configuredForUserId !== userId) {
      await Purchases.logIn(userId);
    }
  } else {
    if (__DEV__) {
      await Purchases.setLogLevel(LOG_LEVEL.WARN);
    }
    Purchases.configure({ apiKey, appUserID: userId });
  }

  configuredForUserId = userId;
  configuredKey = apiKey;
  return { configured: true };
}

export async function configureRevenueCat(userId: string): Promise<BillingConfiguration> {
  if (!isNativeStorePlatform()) {
    return { configured: false, reason: 'unsupported_platform' };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return { configured: false, reason: 'missing_api_key' };
  }

  return runRevenueCatOperation(() => configureRevenueCatInternal(userId, apiKey));
}

export function isRevenueCatConfigured(): boolean {
  return configuredForUserId !== null;
}

export async function logOutRevenueCat(): Promise<void> {
  await runRevenueCatOperation(async () => {
    if (!isNativeStorePlatform() || !configuredForUserId) {
      configuredForUserId = null;
      configuredKey = null;
      return;
    }

    await Purchases.logOut().catch(() => undefined);
    configuredForUserId = null;
    configuredKey = null;
  });
}

function findPackage(offering: PurchasesOffering, ids: readonly string[]): PurchasesPackage | null {
  // Never fall back by package type.  RevenueCat can return a package with a
  // different product when store configuration is incomplete; purchasing it
  // would create a charge that our server deliberately refuses to reconcile.
  return offering.availablePackages.find((candidate) => ids.includes(candidate.product.identifier)) ?? null;
}

export type AnnualTrialEligibility = 'eligible' | 'ineligible' | 'unknown';

export class BillingConfirmationPendingError extends Error {
  readonly code = 'billing_confirmation_pending';

  constructor() {
    super('Your purchase is complete and is still being confirmed. Tap Restore purchases in a moment to finish setup.');
    this.name = 'BillingConfirmationPendingError';
  }
}

export interface BillingOfferings {
  offering: PurchasesOffering;
  annual: PurchasesPackage;
  monthly: PurchasesPackage | null;
  annualTrialEligibility: AnnualTrialEligibility;
  raw: PurchasesOfferings;
}

async function getAnnualTrialEligibility(productId: string): Promise<AnnualTrialEligibility> {
  const purchasesWithEligibility = Purchases as unknown as {
    checkTrialOrIntroductoryPriceEligibility?: (productIdentifiers: string[]) => Promise<Record<string, { status?: number }>>;
  };

  if (typeof purchasesWithEligibility.checkTrialOrIntroductoryPriceEligibility !== 'function') {
    return 'unknown';
  }

  try {
    const eligibility = await purchasesWithEligibility.checkTrialOrIntroductoryPriceEligibility([productId]);
    switch (eligibility[productId]?.status) {
      // RevenueCat's documented INTRO_ELIGIBILITY_STATUS values are
      // eligible=2, ineligible=1, no-offer=3, unknown=0.  Android returns
      // unknown, so it must not display Apple's free-trial claim.
      case 2:
        return 'eligible';
      case 1:
      case 3:
        return 'ineligible';
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

export async function fetchBillingOfferings(expectedUserId?: string): Promise<BillingOfferings | null> {
  return runRevenueCatOperation(async () => {
    if (!isRevenueCatConfigured()) {
      return null;
    }

    const activeUserId = configuredForUserId;
    if (expectedUserId && activeUserId !== expectedUserId) {
      throw new WrongAccountRestoreError();
    }
    if (expectedUserId) {
      await assertRevenueCatUserIsCurrent(expectedUserId);
    }

    const raw = await Purchases.getOfferings();
    if (expectedUserId) {
      await assertRevenueCatUserIsCurrent(expectedUserId);
    }
    const offering = raw.all[MOMORA_OFFERING_ID] ?? raw.current;
    if (!offering) {
      return null;
    }

    const annual = findPackage(offering, MOMORA_ANNUAL_PRODUCT_IDS);
    if (!annual) {
      throw new Error('The annual Momora subscription is not available in this store yet.');
    }

    return {
      offering,
      annual,
      monthly: findPackage(offering, MOMORA_MONTHLY_PRODUCT_IDS),
      annualTrialEligibility: await getAnnualTrialEligibility(annual.product.identifier),
      raw,
    };
  });
}

export async function reconcileBillingAccess(): Promise<boolean> {
  const { data, error } = await invokeEdgeFunction('billing-reconcile', {});
  if (error) {
    throw new Error(error.message);
  }
  return Boolean((data as { active?: boolean } | null)?.active);
}

async function reconcileAfterStoreChange(): Promise<void> {
  const isActive = await reconcileBillingAccess();
  if (!isActive) {
    throw new BillingConfirmationPendingError();
  }
}

async function assertRevenueCatUserIsCurrent(userId: string): Promise<void> {
  const purchasesWithUserId = Purchases as unknown as { getAppUserID?: () => Promise<string> };
  if (typeof purchasesWithUserId.getAppUserID !== 'function') return;
  const appUserId = await purchasesWithUserId.getAppUserID();
  if (appUserId && appUserId !== userId) {
    throw new WrongAccountRestoreError();
  }
}

export async function purchaseBillingPackage(
  packageToPurchase: PurchasesPackage,
  userId: string,
): Promise<CustomerInfo> {
  return runRevenueCatOperation(async () => {
    const apiKey = getApiKey();
    if (!isNativeStorePlatform() || !apiKey) {
      throw new Error('Subscription purchases are unavailable on this device.');
    }
    await configureRevenueCatInternal(userId, apiKey);
    await assertRevenueCatUserIsCurrent(userId);
    const productId = packageToPurchase.product.identifier;
    if (![...MOMORA_ANNUAL_PRODUCT_IDS, ...MOMORA_MONTHLY_PRODUCT_IDS].includes(productId as never)) {
      throw new Error('This Momora subscription product is not configured for purchase.');
    }
    const { customerInfo } = await Purchases.purchasePackage(packageToPurchase);
    await reconcileAfterStoreChange();
    return customerInfo;
  });
}

export async function restoreBillingPurchases(userId: string): Promise<CustomerInfo> {
  return runRevenueCatOperation(async () => {
    const apiKey = getApiKey();
    if (!isNativeStorePlatform() || !apiKey) {
      throw new Error('Subscription restores are unavailable on this device.');
    }
    await configureRevenueCatInternal(userId, apiKey);
    await assertRevenueCatUserIsCurrent(userId);
    const customerInfo = await Purchases.restorePurchases();
    await reconcileAfterStoreChange();
    return customerInfo;
  });
}

export async function getCustomerInfo(userId: string): Promise<CustomerInfo | null> {
  return runRevenueCatOperation(async () => {
    const apiKey = getApiKey();
    if (!isNativeStorePlatform() || !apiKey) return null;
    await configureRevenueCatInternal(userId, apiKey);
    await assertRevenueCatUserIsCurrent(userId);
    return Purchases.getCustomerInfo();
  });
}

export async function fetchFamilyBillingStatus(
  familyId: string,
): Promise<{ data: CachedFamilyBillingStatus | null; error: BillingServiceError | null }> {
  const network = await NetInfo.fetch();
  let data: unknown = null;
  let error: unknown = null;
  if (network.isConnected !== false) {
    const result = await (supabase as any).rpc('get_family_billing_status', {
      p_family_id: familyId,
    });
    data = result.data;
    error = result.error;
  }

  if (!error && data) {
    const fresh: CachedFamilyBillingStatus = {
      ...(data as FamilyBillingStatus),
      cached_at: Date.now(),
      is_offline: false,
    };
    await AsyncStorage.setItem(cacheKey(familyId), JSON.stringify(fresh));
    return { data: fresh, error: null };
  }

  const cachedJson = await AsyncStorage.getItem(cacheKey(familyId));
  if (cachedJson) {
    try {
      const cached = JSON.parse(cachedJson) as CachedFamilyBillingStatus;
      if (Date.now() - cached.cached_at <= BILLING_STATUS_CACHE_TTL_MS) {
        return {
          data: { ...cached, is_offline: !network.isConnected || network.isInternetReachable === false },
          error: null,
        };
      }
    } catch {
      await AsyncStorage.removeItem(cacheKey(familyId));
    }
  }

  return {
    data: null,
    error: mapError(error, 'Could not check subscription access'),
  };
}

/**
 * New-owner onboarding uses this authoritative server status to skip the
 * purchase screens for an owner-wide complimentary grant. Fail closed: a
 * status error must leave the normal paywall path intact.
 */
export async function hasComplimentaryFamilyAccess(familyId: string): Promise<boolean> {
  try {
    const { data, error } = await (supabase as any).rpc('get_family_billing_status', {
      p_family_id: familyId,
    });

    return !error && data?.has_write_access === true && data?.access_reason === 'complimentary';
  } catch {
    return false;
  }
}

export async function startPendingOnboardingIllustration(
  familyId: string,
  memoryId?: string,
): Promise<{ data: unknown; error: BillingServiceError | null }> {
  const { data: pending, error: pendingError } = await (supabase as any)
    .from('memories')
    .select('id')
    .eq('family_id', familyId)
    .eq('memory_type', 'text_illustration')
    .eq('illustration_status', 'pending')
    .match(memoryId ? { id: memoryId } : { onboarding_attributed: true })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (pendingError) return { data: null, error: mapError(pendingError, 'Could not start your first illustration') };
  if (!pending?.id) return { data: null, error: null };

  const result = await invokeEdgeFunction('generate-illustration', {
    memoryId: pending.id,
    requestIntent: 'initial',
  });
  return result;
}

export function isBillingError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export function addCustomerInfoListener(listener: (customerInfo: CustomerInfo) => void): () => void {
  if (!isRevenueCatConfigured()) return () => undefined;
  Purchases.addCustomerInfoUpdateListener(listener);
  return () => Purchases.removeCustomerInfoUpdateListener(listener);
}
