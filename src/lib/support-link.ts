// Email support links. Separate from the review flow on purpose: an unhappy
// parent is offered a way to reach us, never a review prompt.
import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';

import { trackEvent } from '@/services/analytics';

export const SUPPORT_EMAIL_URL = 'mailto:hello@usemomora.com';

export type SupportLinkSource = 'illustration_failed' | 'save_failed';

const SUPPORT_SUBJECTS: Record<SupportLinkSource, string> = {
  illustration_failed: 'Momora: illustration problem',
  save_failed: "Momora: memory didn't save",
};

/** App version + platform only -- never memory content, names, or ids. */
export function buildSupportEmailUrl(source: SupportLinkSource): string {
  const version = Constants.expoConfig?.version ?? 'unknown';
  const body = `\n\n---\nApp version: ${version}\nPlatform: ${Platform.OS}`;
  return `${SUPPORT_EMAIL_URL}?subject=${encodeURIComponent(SUPPORT_SUBJECTS[source])}&body=${encodeURIComponent(body)}`;
}

export async function openSupportEmail(source: SupportLinkSource): Promise<void> {
  try {
    await Linking.openURL(buildSupportEmailUrl(source));
    trackEvent('support_link_opened', { source });
  } catch {
    // No mail app configured; nothing more to offer from here.
  }
}
