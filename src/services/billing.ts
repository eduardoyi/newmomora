import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import Purchases, {
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesOfferings,
  type PurchasesPackage,
  type SubscriptionOption,
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

export interface BillingPurchaseOptions {
  useAnnualTrial?: boolean;
}

function getSevenDayFreeTrialMismatch(option: SubscriptionOption): string | null {
  const phase = option.freePhase;
  if (!phase) return 'no free phase';

  // A free phase may be represented as a pricing period with multiple cycles;
  // only a single, explicitly free trial phase matches the copy we show.
  if (phase.billingCycleCount != null && phase.billingCycleCount !== 1) {
    return `billingCycleCount=${phase.billingCycleCount}`;
  }
  if (phase.recurrenceMode === 1) return 'recurrenceMode=INFINITE_RECURRING';
  if (phase.offerPaymentMode != null && phase.offerPaymentMode !== 'FREE_TRIAL') {
    return `offerPaymentMode=${phase.offerPaymentMode}`;
  }

  const period = phase.billingPeriod;
  if (!period) return 'free phase has no billing period';

  // RevenueCat can represent the same Google Play offer as either seven days
  // or one week depending on the store response. The paywall promises seven
  // days, so only advertise those exact durations.
  const isSevenDays =
    (period.unit === 'DAY' && period.value === 7) ||
    (period.unit === 'WEEK' && period.value === 1) ||
    period.iso8601 === 'P7D' ||
    period.iso8601 === 'P1W';
  return isSevenDays ? null : `period is ${period.value} ${period.unit} (${period.iso8601}), not 7 days`;
}

function isSevenDayFreeTrial(option: SubscriptionOption): boolean {
  return getSevenDayFreeTrialMismatch(option) === null;
}

function isOptionForProduct(option: SubscriptionOption, product: PurchasesPackage['product']): boolean {
  // RevenueCat represents newer Google products as `subscription:basePlan`
  // while older/backwards-compatible products may expose just `subscription`.
  // The option itself came from this StoreProduct, but keep this check so a
  // malformed/stale native response cannot make us purchase another product.
  const storeProductId = option.storeProductId ?? '';
  const productId = option.productId ?? '';
  return (
    storeProductId === product.identifier ||
    productId === product.identifier ||
    storeProductId.startsWith(`${product.identifier}:`) ||
    product.identifier.startsWith(`${productId}:`)
  );
}

function getGooglePlaySubscriptionOptions(product: PurchasesPackage['product']): SubscriptionOption[] {
  return product.subscriptionOptions ?? (product.defaultOption ? [product.defaultOption] : []);
}

function getGooglePlayTrialOption(packageToPurchase: PurchasesPackage): SubscriptionOption | null {
  const product = packageToPurchase.product;
  const eligibleTrial = getGooglePlaySubscriptionOptions(product).find(
    (option) =>
      !option.isBasePlan &&
      isOptionForProduct(option, product) &&
      !(option.tags ?? []).includes('rc-ignore-offer') &&
      isSevenDayFreeTrial(option),
  );
  return eligibleTrial ?? null;
}

function getTrialRejectionReason(option: SubscriptionOption, product: PurchasesPackage['product']): string | null {
  if (option.isBasePlan) return 'base plan, not an offer';
  if (!isOptionForProduct(option, product)) return `product mismatch (expected ${product.identifier})`;
  if ((option.tags ?? []).includes('rc-ignore-offer')) return 'tagged rc-ignore-offer';
  return getSevenDayFreeTrialMismatch(option);
}

/**
 * Dev-only paywall diagnostic: when the annual trial is not offered, dumps
 * exactly what the native Play Billing / RevenueCat layer returned and why
 * each subscription option was rejected as the 7-day trial. Silent when
 * eligible so the happy path stays quiet. Product metadata only — never log
 * customer info here.
 */
function logAndroidTrialDiagnostics(annual: PurchasesPackage, eligibility: AnnualTrialEligibility): void {
  if (!__DEV__ || eligibility === 'eligible') return;
  const product = annual.product;
  const diagnostics = {
    eligibility,
    packageIdentifier: annual.identifier,
    productIdentifier: product.identifier,
    subscriptionOptionsPresent: product.subscriptionOptions != null,
    subscriptionOptionCount: product.subscriptionOptions?.length ?? null,
    defaultOptionId: product.defaultOption?.id ?? null,
    options: getGooglePlaySubscriptionOptions(product).map((option) => ({
      id: option.id,
      storeProductId: option.storeProductId,
      productId: option.productId,
      isBasePlan: option.isBasePlan,
      tags: option.tags,
      trialRejectionReason: getTrialRejectionReason(option, product),
      freePhase: option.freePhase,
      pricingPhases: option.pricingPhases?.map((phase) => ({
        billingPeriod: phase.billingPeriod,
        recurrenceMode: phase.recurrenceMode,
        billingCycleCount: phase.billingCycleCount,
        offerPaymentMode: phase.offerPaymentMode,
        price: phase.price?.formatted,
      })),
    })),
  };
  console.warn('[billing:android-trial]', JSON.stringify(diagnostics, null, 2));
}

function getAndroidAnnualTrialEligibility(annual: PurchasesPackage): AnnualTrialEligibility {
  // RevenueCat's Android introductory-eligibility API always returns UNKNOWN.
  // Google puts customer-eligible offers in subscriptionOptions. In normal
  // operation defaultOption points at the same offer the SDK would select,
  // but Play Billing Lab can override eligibility without changing that
  // convenience property, so inspect the complete eligible option list.
  const eligibility =
    !annual.product.subscriptionOptions && !annual.product.defaultOption
      ? 'unknown'
      : getGooglePlayTrialOption(annual)
        ? 'eligible'
        : 'ineligible';
  logAndroidTrialDiagnostics(annual, eligibility);
  return eligibility;
}

function getGooglePlayBasePlanOption(packageToPurchase: PurchasesPackage): SubscriptionOption | null {
  const product = packageToPurchase.product;
  const basePlanOption = getGooglePlaySubscriptionOptions(product).find(
    (option) => option.isBasePlan && isOptionForProduct(option, product),
  );
  if (basePlanOption) return basePlanOption;

  const defaultOption = product.defaultOption;
  return defaultOption?.isBasePlan && isOptionForProduct(defaultOption, product) ? defaultOption : null;
}

async function getAnnualTrialEligibility(annual: PurchasesPackage): Promise<AnnualTrialEligibility> {
  if (Platform.OS === 'android') {
    return getAndroidAnnualTrialEligibility(annual);
  }

  const productId = annual.product.identifier;
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
      // eligible=2, ineligible=1, no-offer=3, unknown=0. Android uses the
      // Google Play subscription-option path above instead.
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
      annualTrialEligibility: await getAnnualTrialEligibility(annual),
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
  options: BillingPurchaseOptions = {},
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
    const purchaseResult =
      Platform.OS === 'android'
        ? await (async () => {
            const subscriptionOption = options.useAnnualTrial
              ? getGooglePlayTrialOption(packageToPurchase)
              : getGooglePlayBasePlanOption(packageToPurchase);
            if (!subscriptionOption) {
              throw new Error('This Google Play subscription option is no longer available. Reload and try again.');
            }
            return Purchases.purchaseSubscriptionOption(subscriptionOption);
          })()
        : await Purchases.purchasePackage(packageToPurchase);
    const { customerInfo } = purchaseResult;
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
