// Holiday card product page (docs/plans/keepsakes-redesign.md D3), opened
// from the Keepsakes storefront. A stack screen (no tab bar). The CTA follows
// `holidayCardTileState`: "make" opens the greeting sheet and, once a NEW card
// is created, leaves the page (back to the tab, where the card now shows
// "Being made"); every other state opens the shop. No prices: they live in the
// shop. See docs/features/keepsakes.md.
import { useCallback, useEffect, useRef, useState } from 'react';

import { FreeToMake } from '@/components/keepsakes/free-to-make';
import { HolidayCardObject, holidayCardFamilyLine } from '@/components/keepsakes/holiday-card-object';
import { HolidayGreetingSheet } from '@/components/keepsakes/holiday-greeting-sheet';
import {
  EligibilityBox,
  FactsBox,
  PrivacyNote,
  ProductCtaBar,
  ProductHeading,
  ProductPageLoading,
  ProductPageShell,
  ProductStage,
  ShipByPill,
  type ProductFact,
} from '@/components/keepsakes/product-page';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useHolidayCard, type CreateHolidayCardOutcome } from '@/hooks/useHolidayCard';
import { useKeepsakesOverview } from '@/hooks/useKeepsakesOverview';
import { useLeaveKeepsakesPage } from '@/hooks/useLeaveKeepsakesPage';
import { holidayCardWebUrl, type HolidayCardGreeting } from '@/services/holiday-cards';
import { openShopUrl } from '@/services/web-handoff';
import { isOwnChild } from '@/utils/family-relationships';
import { holidayCardTileState, type HolidayCardTileState } from '@/utils/holiday-card-state';
import { holidayCardEligibility } from '@/utils/keepsake-product-pages';
import { getLocalTodayIso } from '@/utils/portrait-versions';
import { canEditFamilyContent } from '@/utils/roles';

const HOLIDAY_CARD_PAGE_TITLE = 'Your family, on this year’s card.';
const HOLIDAY_CARD_PAGE_BODY =
  'A printed holiday card with your family’s own picture on the front and a letter from your year on the back.';
const HOLIDAY_CARD_CTA_SUBLINE = 'Pick a greeting, then make it your own in the app.';

function ctaLabel(state: HolidayCardTileState, year: number): string {
  return state === 'make' ? `Make our ${year} card` : 'Open your card';
}

export default function HolidayCardProductScreen() {
  const { familyId, role, isLoading: isFamilyLoading } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const { members } = useFamilyMembers();
  const { summary, create, isLoading: isSummaryLoading } = useHolidayCard(familyId, { enabled: canEdit });
  const { overview } = useKeepsakesOverview(familyId, { enabled: canEdit });
  const { leave, leaveAfterModalDismiss } = useLeaveKeepsakesPage();
  // A stack screen: "today" is fixed for this visit.
  const [todayIso] = useState(() => getLocalTodayIso());
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  // Set when a create produced a NEW card; only then does closing the sheet
  // leave the page (a refused create keeps the user here to read why).
  const createdRef = useRef(false);

  const currentYear = Number(todayIso.slice(0, 4));
  const state = canEdit ? holidayCardTileState(summary, todayIso) : null;
  const isSettled = !isFamilyLoading && !(canEdit && isSummaryLoading);

  // Latch the first settled state. A first-load null (out of season, no
  // billing, viewer, a deep link) leaves; a state that turns null LATER (a
  // refused create refetching a summary that hides the card) never does.
  const hasLatchedRef = useRef(false);
  useEffect(() => {
    if (!isSettled || hasLatchedRef.current) return;
    hasLatchedRef.current = true;
    if (state === null) leave();
  }, [isSettled, state, leave]);

  // Keep showing the last real state once the live one goes null.
  const [lastState, setLastState] = useState<HolidayCardTileState | null>(null);
  if (state !== null && state !== lastState) setLastState(state);
  const shownState = state ?? lastState;

  const handleCreate = useCallback(
    async (greeting: HolidayCardGreeting): Promise<CreateHolidayCardOutcome> => {
      const outcome = await create(greeting);
      if (outcome.ok && outcome.result.created) createdRef.current = true;
      return outcome;
    },
    [create],
  );

  const handleSheetClose = useCallback(() => {
    setIsSheetOpen(false);
    if (createdRef.current) leaveAfterModalDismiss();
  }, [leaveAfterModalDismiss]);

  const openCard = useCallback((cardId: string) => {
    void openShopUrl(holidayCardWebUrl(cardId));
  }, []);

  if (!isSettled || shownState === null) {
    return (
      <ProductPageShell onBack={leave} testID="keepsakes-product-holiday-card">
        <ProductPageLoading />
      </ProductPageShell>
    );
  }

  // The card's year: this year while there is nothing to open yet, else the card's own.
  const year = shownState === 'make' || !summary?.year ? currentYear : summary.year;
  const childNames = members
    .filter((member) => isOwnChild(member, new Date(`${todayIso}T12:00:00`)))
    .map((member) => member.name.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name.length > 0);
  const eligibility = holidayCardEligibility(overview, year);

  const facts: ProductFact[] = [{ lead: '5×7, printed on both sides.', rest: 'Shipped to your door.' }];
  if (eligibility.promisesFilm === true) {
    facts.push({ lead: 'Scan the back', rest: 'to watch a short film made for this card.' });
  } else if (eligibility.promisesFilm === false) {
    facts.push({ lead: 'Add a few more moments', rest: 'and the back links to a short film of your year.' });
  }
  facts.push({ lead: 'One card per family each year.', rest: 'Order more copies anytime.' });

  const handleCta = () => {
    if (shownState === 'make') {
      setIsSheetOpen(true);
    } else if (summary?.cardId) {
      openCard(summary.cardId);
    }
  };

  return (
    <>
      <ProductPageShell
        footer={
          <ProductCtaBar
            label={ctaLabel(shownState, year)}
            onPress={handleCta}
            subline={HOLIDAY_CARD_CTA_SUBLINE}
            testID="holiday-card-product-cta"
          />
        }
        onBack={leave}
        testID="keepsakes-product-holiday-card"
      >
        <ProductStage testID="holiday-card-product-stage">
          <HolidayCardObject
            familyLine={holidayCardFamilyLine(childNames, year)}
            imageKey={overview?.preview_key ?? null}
            testID="holiday-card-product-object"
            width={154}
          />
        </ProductStage>
        <ProductHeading
          body={HOLIDAY_CARD_PAGE_BODY}
          eyebrow={`Holiday cards · ${year}`}
          title={HOLIDAY_CARD_PAGE_TITLE}
        />
        <FreeToMake product="card" />
        {eligibility.line ? (
          <EligibilityBox testID="holiday-card-eligibility">{eligibility.line}</EligibilityBox>
        ) : null}
        {overview?.has_viewers ? <PrivacyNote product="card" /> : null}
        <FactsBox facts={facts} />
        {overview?.holiday_ship_by_note ? <ShipByPill text={overview.holiday_ship_by_note} /> : null}
      </ProductPageShell>

      {/* Mounted for the whole visit: a refused create refetches a summary
          that can hide the card, and the sheet must stay to show why. */}
      <HolidayGreetingSheet
        language={summary?.language ?? 'en'}
        onClose={handleSheetClose}
        onCreate={handleCreate}
        onOpenCard={openCard}
        visible={isSheetOpen}
      />
    </>
  );
}
