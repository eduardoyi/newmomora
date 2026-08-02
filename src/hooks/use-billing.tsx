import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  addCustomerInfoListener,
  configureRevenueCat,
  fetchBillingOfferings,
  fetchFamilyBillingStatus,
  logOutRevenueCat,
  purchaseBillingPackage,
  reconcileBillingAccess,
  restoreBillingPurchases,
  startPendingOnboardingIllustration,
  type BillingOfferings,
  type BillingServiceError,
} from '@/services/billing';
import type { CustomerInfo, PurchasesPackage } from 'react-native-purchases';

export const billingStatusQueryKey = ['family-billing-status'] as const;
export const billingOfferingsQueryKey = ['revenuecat-offerings'] as const;

interface BillingContextValue {
  offerings: BillingOfferings | null;
  status: Awaited<ReturnType<typeof fetchFamilyBillingStatus>>['data'];
  isConfigured: boolean;
  isLoading: boolean;
  isOffline: boolean;
  billingStatusError: BillingServiceError | Error | null;
  offeringsError: Error | null;
  purchase: (packageToPurchase: PurchasesPackage) => Promise<CustomerInfo>;
  restore: () => Promise<CustomerInfo>;
  startOnboardingIllustration: (memoryId?: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const BillingContext = createContext<BillingContextValue | null>(null);

export function BillingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();
  const [configuredUserId, setConfiguredUserId] = useState<string | null>(null);
  const lastReconcileAtRef = useRef(0);
  const lastReconcileUserIdRef = useRef<string | null>(null);
  const reconcileInFlightRef = useRef<{ userId: string; promise: Promise<boolean> } | null>(null);
  const billingTransitionRef = useRef(0);
  const logoutInFlightRef = useRef<Promise<void> | null>(null);
  const isConfigured = Boolean(user && configuredUserId === user.id);
  const billingUserId = user?.id ?? null;

  const reconcileAndRefresh = useCallback(async (force = false): Promise<boolean> => {
    if (!isConfigured || !billingUserId) return false;
    const now = Date.now();
    if (
      !force &&
      lastReconcileUserIdRef.current === billingUserId &&
      now - lastReconcileAtRef.current < 5 * 60 * 1000
    ) {
      return true;
    }
    if (reconcileInFlightRef.current?.userId === billingUserId) {
      return reconcileInFlightRef.current.promise;
    }

    const promise = reconcileBillingAccess()
      .then((active) => {
        lastReconcileAtRef.current = Date.now();
        lastReconcileUserIdRef.current = billingUserId;
        void queryClient.invalidateQueries({ queryKey: billingStatusQueryKey });
        return active;
      })
      .finally(() => {
        if (reconcileInFlightRef.current?.userId === billingUserId) {
          reconcileInFlightRef.current = null;
        }
      });
    reconcileInFlightRef.current = { userId: billingUserId, promise };
    return promise;
  }, [billingUserId, isConfigured, queryClient]);

  useEffect(() => {
    const transition = billingTransitionRef.current + 1;
    billingTransitionRef.current = transition;
    let mounted = true;

    // Invalidate the React-side identity synchronously. This matters when a
    // user signs out and signs back in as the same Momora account before the
    // asynchronous RevenueCat logout has finished: without this reset,
    // `isConfigured` briefly remains true and the offerings query can call
    // StoreKit/Play with the previous customer.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the identity must be invalidated before any enabled query can observe this session
    setConfiguredUserId(null);

    if (!user) {
      lastReconcileAtRef.current = 0;
      lastReconcileUserIdRef.current = null;
      // Trial eligibility and available packages can change when the device's
      // StoreKit/Play account changes, even if the Momora user signs back in
      // with the same email. Never let the next session reuse an offerings or
      // family-status result from the previous customer.
      queryClient.removeQueries({ queryKey: billingOfferingsQueryKey });
      queryClient.removeQueries({ queryKey: billingStatusQueryKey });
      const logoutPromise = logOutRevenueCat();
      logoutInFlightRef.current = logoutPromise;
      void logoutPromise.finally(() => {
        if (logoutInFlightRef.current === logoutPromise) {
          logoutInFlightRef.current = null;
        }
      });
      return () => {
        mounted = false;
      };
    }

    void (async () => {
      const previousLogout = logoutInFlightRef.current;
      if (previousLogout) {
        await previousLogout.catch(() => undefined);
      }
      if (!mounted || billingTransitionRef.current !== transition) {
        return;
      }

      try {
        const result = await configureRevenueCat(user.id);
        if (mounted && billingTransitionRef.current === transition) {
          setConfiguredUserId(result.configured ? user.id : null);
        }
      } catch {
        if (mounted && billingTransitionRef.current === transition) {
          setConfiguredUserId(null);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [queryClient, user]);

  useEffect(() => {
    if (!isConfigured) return;
    void reconcileAndRefresh().catch(() => undefined);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void reconcileAndRefresh().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [isConfigured, reconcileAndRefresh]);

  const offeringsQuery = useQuery({
    // Trial eligibility is customer-specific even though the product catalog
    // is app-wide. Keeping the user id in the key prevents a logout/login from
    // reusing the previous tester's eligibility or a transient empty result.
    queryKey: [...billingOfferingsQueryKey, billingUserId],
    queryFn: () => fetchBillingOfferings(billingUserId as string),
    enabled: isConfigured,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const statusQuery = useQuery({
    queryKey: [...billingStatusQueryKey, familyId],
    queryFn: () => fetchFamilyBillingStatus(familyId as string),
    enabled: Boolean(familyId),
    staleTime: 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    if (!isConfigured) return;
    return addCustomerInfoListener(() => {
      void reconcileAndRefresh(true).catch(() => undefined);
    });
  }, [isConfigured, reconcileAndRefresh]);

  const purchaseMutation = useMutation({
    mutationFn: async (packageToPurchase: PurchasesPackage) => {
      if (!user) throw new Error('You must be signed in to subscribe.');
      return purchaseBillingPackage(packageToPurchase, user.id);
    },
    onSuccess: async () => {
      await statusQuery.refetch();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error('You must be signed in to restore purchases.');
      return restoreBillingPurchases(user.id);
    },
    onSuccess: async () => {
      await statusQuery.refetch();
    },
  });

  const startIllustrationMutation = useMutation({
    mutationFn: async (memoryId?: string) => {
      if (!familyId) return;
      const result = await startPendingOnboardingIllustration(familyId, memoryId);
      if (result.error) throw new Error(result.error.message);
    },
  });

  const purchaseAsync = purchaseMutation.mutateAsync;
  const restoreAsync = restoreMutation.mutateAsync;
  const startIllustrationAsync = startIllustrationMutation.mutateAsync;
  const refetchOfferings = offeringsQuery.refetch;
  const refetchStatus = statusQuery.refetch;

  const purchase = useCallback(
    (packageToPurchase: PurchasesPackage) => purchaseAsync(packageToPurchase),
    [purchaseAsync],
  );
  const restore = useCallback(() => restoreAsync(), [restoreAsync]);
  const startOnboardingIllustration = useCallback(
    (memoryId?: string) => startIllustrationAsync(memoryId),
    [startIllustrationAsync],
  );
  const refresh = useCallback(async () => {
    // A paywall can mount in the same render that starts RevenueCat
    // configuration. Refetching while `isConfigured` is false makes
    // fetchBillingOfferings return null; React Query then treats that empty
    // result as fresh and may not refetch when configuration finishes. Wait
    // for the enabled offerings query instead of caching the pre-configured
    // placeholder.
    const requests: Promise<unknown>[] = [refetchStatus()];
    if (isConfigured) {
      requests.push(refetchOfferings());
    }
    await Promise.all(requests);
  }, [isConfigured, refetchOfferings, refetchStatus]);

  const offerings = offeringsQuery.data ?? null;
  const status = statusQuery.data?.data ?? null;
  const isLoading = offeringsQuery.isLoading || statusQuery.isLoading;
  const isOffline = Boolean(status?.is_offline);
  const billingStatusError = useMemo<BillingServiceError | Error | null>(
    () =>
      statusQuery.data?.error ??
      (statusQuery.error
        ? new Error(statusQuery.error instanceof Error ? statusQuery.error.message : 'Could not check subscription access')
        : null),
    [statusQuery.data?.error, statusQuery.error],
  );
  const offeringsError = useMemo<Error | null>(
    () =>
      offeringsQuery.error
        ? new Error(offeringsQuery.error instanceof Error ? offeringsQuery.error.message : 'Could not load subscription options')
        : null,
    [offeringsQuery.error],
  );

  const value = useMemo<BillingContextValue>(
    () => ({
      offerings,
      status,
      isConfigured,
      isLoading,
      isOffline,
      billingStatusError,
      offeringsError,
      purchase,
      restore,
      startOnboardingIllustration,
      refresh,
    }),
    [
      offerings,
      status,
      isConfigured,
      isLoading,
      isOffline,
      billingStatusError,
      offeringsError,
      purchase,
      restore,
      startOnboardingIllustration,
      refresh,
    ],
  );

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

export function useBilling(): BillingContextValue {
  const context = useContext(BillingContext);
  if (!context) throw new Error('useBilling must be used within BillingProvider');
  return context;
}
