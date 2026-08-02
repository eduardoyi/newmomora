export const MOMORA_ENTITLEMENT_ID = 'momora_plus';
export const MOMORA_OFFERING_ID = 'default';
export const MOMORA_ANNUAL_PRODUCT_IDS = ['momora_annual_v1', 'momora:annual'] as const;
export const MOMORA_MONTHLY_PRODUCT_IDS = ['momora_monthly_v1', 'momora:monthly'] as const;

export const REVENUECAT_IOS_KEY_ENV = 'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY';
export const REVENUECAT_ANDROID_KEY_ENV = 'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY';

export const BILLING_STATUS_CACHE_TTL_MS = 15 * 60 * 1000;

export type BillingAccessReason =
  | 'off'
  | 'legacy_grace'
  | 'complimentary'
  | 'active'
  | 'trial'
  | 'grace'
  | 'billing_grace'
  | 'expired';

export interface FamilyBillingStatus {
  family_id: string;
  owner_user_id: string;
  has_write_access: boolean;
  has_ever_had_access: boolean;
  trial_eligible: boolean;
  access_reason: BillingAccessReason;
  period_type: 'monthly' | 'annual' | null;
  expires_at: string | null;
  grace_until: string | null;
  will_renew: boolean;
  management_url: string | null;
  enforcement_mode: 'off' | 'new_families' | 'all_families';
  sandbox_access_enabled?: boolean;
  new_family_cutover_at: string;
  min_supported_app_version: string;
}

export interface CachedFamilyBillingStatus extends FamilyBillingStatus {
  cached_at: number;
  is_offline: boolean;
}

export class WrongAccountRestoreError extends Error {
  readonly code = 'wrong_account_restore';

  constructor() {
    super('This purchase belongs to a different Momora account. Sign in to that account or contact support.');
    this.name = 'WrongAccountRestoreError';
  }
}
