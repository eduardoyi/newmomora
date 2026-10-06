// The Keepsakes holiday-card entry (docs/plans/holiday-cards-p2.md Step 6,
// docs/features/holiday-cards.md). Rendered above the year sections for
// owners/managers when the family has a card OR the server switch is on
// (`holiday_card_summary`). One tile, five states:
//   make        -> opens the greeting sheet (creates the card, then the shop)
//   generating  -> "Preparing your card…", opens the shop (it waits/polls)
//   ready       -> "Edit & order your card", opens the shop editor
//   failed      -> "We couldn't make your card", opens the shop (details)
//   ordered     -> "Your cards are ordered", opens the shop (status/reorder)
// The shop is opened with `openShopUrl` (signed-in handoff).
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { HolidayGreetingSheet } from '@/components/keepsakes/holiday-greeting-sheet';
import { colors, fonts, radius } from '@/constants/theme';
import { useHolidayCard } from '@/hooks/useHolidayCard';
import { holidayCardWebUrl, type HolidayCardSummary } from '@/services/holiday-cards';
import { openShopUrl } from '@/services/web-handoff';

export type HolidayCardTileState = 'make' | 'generating' | 'ready' | 'failed' | 'ordered';

/**
 * Which tile (if any) the summary calls for. The summary returns the newest
 * card of ANY year, so `todayIso` (the tab's local today) decides what a
 * previous-year card means: if it was ordered it stays reachable as "ordered"
 * through Jan 31 of the following year (the cards are in transit and tracking
 * lives in the shop); after that, or if it was never ordered, it counts as no
 * card (offer "make" when the switch is on, else hide the tile).
 */
export function holidayCardTileState(
  summary: HolidayCardSummary | null,
  todayIso: string,
): HolidayCardTileState | null {
  if (!summary) return null;
  const currentYear = Number(todayIso.slice(0, 4));
  let hasCard = summary.cardId !== null;
  if (hasCard && summary.year !== null && summary.year < currentYear) {
    hasCard = summary.ordered && summary.year === currentYear - 1 && todayIso <= `${currentYear}-01-31`;
  }
  if (!hasCard) return summary.enabled ? 'make' : null;
  if (summary.ordered) return 'ordered';
  if (summary.status === 'ready') return 'ready';
  if (summary.status === 'failed') return 'failed';
  return 'generating';
}

const COPY: Record<HolidayCardTileState, { title: string; subtitle: string }> = {
  make: {
    title: 'Make your holiday card',
    subtitle: 'A printed card with a QR to your year’s film. Ships to the US & Canada.',
  },
  generating: {
    title: 'Preparing your card…',
    subtitle: 'This takes a couple of minutes. Tap to follow along.',
  },
  ready: {
    title: 'Edit & order your card',
    subtitle: 'Your card is ready to personalize and print.',
  },
  failed: {
    title: 'We couldn’t make your card',
    subtitle: 'Tap for details, or write to hello@usemomora.com.',
  },
  ordered: {
    title: 'Your cards are ordered',
    subtitle: 'Tap to see the order status.',
  },
};

export interface HolidayCardTileProps {
  familyId: string | null | undefined;
  /** `canEditFamilyContent(role)`: viewers never see the tile (and nothing is fetched). */
  canEdit: boolean;
  /** The screen's local "today" (`YYYY-MM-DD`; see `holidayCardTileState`). */
  todayIso: string;
  /** The tab's real focus state (tab screens never unmount). */
  isFocused: boolean;
}

export function HolidayCardTile({ familyId, canEdit, todayIso, isFocused }: HolidayCardTileProps) {
  const { summary, create, refetch } = useHolidayCard(familyId, { enabled: canEdit, isFocused });
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  // Tab screens never unmount: refresh the summary each time the tab is focused.
  useEffect(() => {
    if (canEdit && isFocused && familyId) void refetch({ cancelRefetch: false });
  }, [canEdit, familyId, isFocused, refetch]);

  const openCard = useCallback((cardId: string) => {
    void openShopUrl(holidayCardWebUrl(cardId));
  }, []);

  const state = canEdit ? holidayCardTileState(summary, todayIso) : null;
  if (!canEdit) return null;

  const copy = state ? COPY[state] : null;
  const handlePress = () => {
    if (state === 'make') {
      setIsSheetOpen(true);
    } else if (summary?.cardId) {
      openCard(summary.cardId);
    }
  };

  const tone = state === 'failed' ? styles.iconFailed : state === 'ordered' ? styles.iconOrdered : styles.iconDefault;
  const iconColor = state === 'failed' ? colors.sunInk : state === 'ordered' ? colors.success : colors.primaryDark;

  return (
    <>
      {state && copy ? (
        <View style={styles.wrap} testID="holiday-card-tile">
          <Pressable
            accessibilityHint={state === 'make' ? 'Opens the greeting choices' : 'Opens the card in your browser'}
            accessibilityLabel={`${copy.title}. ${copy.subtitle}`}
            accessibilityRole="button"
            onPress={handlePress}
            style={({ pressed }) => [styles.card, state === 'failed' && styles.cardFailed, pressed && styles.pressed]}
            testID={`holiday-card-tile-${state}`}
          >
            <View style={[styles.iconCircle, tone]}>
              {state === 'generating' ? (
                <ActivityIndicator color={colors.primaryDark} size="small" />
              ) : (
                <SymbolView
                  fallback={<Text style={[styles.iconFallback, { color: iconColor }]}>{state === 'ordered' ? '✓' : '✉'}</Text>}
                  name={
                    state === 'failed'
                      ? { ios: 'exclamationmark.triangle', android: 'warning' }
                      : state === 'ordered'
                        ? { ios: 'checkmark.circle', android: 'check_circle' }
                        : { ios: 'envelope', android: 'mail' }
                  }
                  size={22}
                  tintColor={iconColor}
                />
              )}
            </View>
            <View style={styles.textCol}>
              <Text style={styles.title}>{copy.title}</Text>
              <Text style={styles.subtitle}>{copy.subtitle}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Mounted independently of the tile: a refused create refetches a
          summary that hides the tile, and the sheet must stay to show why. */}
      <HolidayGreetingSheet
        language={summary?.language ?? 'en'}
        onClose={() => setIsSheetOpen(false)}
        onCreate={create}
        onOpenCard={openCard}
        visible={isSheetOpen}
      />
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 24 },
  card: {
    alignItems: 'center',
    backgroundColor: colors.primaryTint,
    borderColor: colors.primarySoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  cardFailed: { backgroundColor: colors.sunSoft, borderColor: colors.sun },
  pressed: { opacity: 0.85 },
  iconCircle: {
    alignItems: 'center',
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  iconDefault: { backgroundColor: colors.white },
  iconFailed: { backgroundColor: colors.white },
  iconOrdered: { backgroundColor: colors.successSoft },
  iconFallback: { fontSize: 20, fontWeight: '700' },
  textCol: { flex: 1, gap: 2 },
  title: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 17, lineHeight: 22 },
  subtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18 },
  chevron: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 24, lineHeight: 26 },
});
