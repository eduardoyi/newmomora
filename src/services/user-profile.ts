import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type UserProfile = Database['public']['Tables']['user_profiles']['Row'];

export interface ServiceError {
  message: string;
  code?: string;
}

export interface UpdateUserProfileInput {
  name?: string;
  timezone?: string;
  enableDailyReminder?: boolean;
  notificationTime?: string | null;
  expoPushToken?: string | null;
  hasCompletedOnboarding?: boolean;
  /** Switches the caller's active family (FamilyProvider.setActiveFamily). */
  activeFamilyId?: string;
  /** "New memory alerts" Settings toggle (plan §10). */
  notifyNewMemories?: boolean;
  /** Likes/comments push preference; recipient-side and global across families. */
  notifyEngagement?: boolean;
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return {
    message: error.message,
    code: error.code,
  };
}

export async function fetchUserProfile(): Promise<{
  data: UserProfile | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase.from('user_profiles').select('*').maybeSingle();

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data, error: null };
}

export async function updateUserProfile(
  input: UpdateUserProfileInput,
): Promise<{ data: UserProfile | null; error: ServiceError | null }> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      data: null,
      error: { message: authError?.message ?? 'You must be signed in to update your profile' },
    };
  }

  const { data, error } = await supabase
    .from('user_profiles')
    .update({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.enableDailyReminder !== undefined
        ? { enable_daily_reminder: input.enableDailyReminder }
        : {}),
      ...(input.notificationTime !== undefined ? { notification_time: input.notificationTime } : {}),
      ...(input.expoPushToken !== undefined ? { expo_push_token: input.expoPushToken } : {}),
      ...(input.hasCompletedOnboarding !== undefined
        ? { has_completed_onboarding: input.hasCompletedOnboarding }
        : {}),
      ...(input.activeFamilyId !== undefined ? { active_family_id: input.activeFamilyId } : {}),
      ...(input.notifyNewMemories !== undefined
        ? { notify_new_memories: input.notifyNewMemories }
        : {}),
      ...(input.notifyEngagement !== undefined
        ? { notify_engagement: input.notifyEngagement }
        : {}),
    })
    .eq('id', user.id)
    .select('*')
    .maybeSingle();

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data, error: null };
}
