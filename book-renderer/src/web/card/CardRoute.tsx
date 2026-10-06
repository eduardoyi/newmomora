import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { FrontPhotoProvider } from '../../card/preview/photoProvider';
import { signOut } from '../auth/useAuthSession';
import { useHasPastOrders } from '../order/useHasPastOrders';
import { CardApiError, fetchPickerPool, getCardMediaUrls, getFilmUrls } from './cardApi';
import { cancelCardCheckout } from './checkout/cardOrdersApi';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { CardEditsProvider, useCardEdits, type CardEditsContextValue } from './CardEditsProvider';
import { CardEditorScreen } from './CardEditorScreen';
import { isCancelDoneCode, serverReadFrom } from './editorState';
import { createPickerProvider } from './pickerProvider';
import { useCardFonts } from './useCardHooks';
import { useHolidayCard, type UseHolidayCard } from './useHolidayCard';

/**
 * The `/c/<cardId>` route (lazy-loaded: see `CardRouteLazy.tsx`). Owns the
 * card's server state and its ONE save queue, and sits above both the editor
 * and the checkout screen, so edits made before Order are the edits Checkout
 * reads, and Order waits for the queue to flush.
 *
 * What the checkout screen gets (`renderCheckout`): the loaded card, the live
 * edits context (`useCardEdits()` also works anywhere below this route), a
 * `refetch`, and `onBack` to return to the editor. The page URL keeps its
 * `?order=` / `?checkout=` query so a Stripe return lands on the checkout view.
 */

export interface CardCheckoutContext {
  cardId: string;
  card: UseHolidayCard;
  edits: CardEditsContextValue;
  /** Back to the editor (the edits queue stays mounted). */
  onBack: () => void;
  /** The resume target when the page was opened from a Stripe return or a "Continue checkout". */
  orderId: string | null;
  returnStatus: 'success' | 'cancelled' | null;
}

export interface CardRouteProps {
  cardId: string;
  /** Renders the checkout view in place of the editor (the editor's Order button switches to it). Without it, Order calls `onOrder`. */
  renderCheckout?: (ctx: CardCheckoutContext) => ReactNode;
  /** Used when `renderCheckout` is absent. */
  onOrder?: () => void;
  onOpenOrder?: (orderId: string) => void;
  /** The buyer's orders page (`/orders`): offered as a link when they have past orders, like the book page. */
  onOpenOrders?: () => void;
  /** "Sign out and switch account" (default: the shop's sign-out). */
  onSignOut?: () => void | Promise<void>;
}

function readReturnParams(): { orderId: string | null; returnStatus: 'success' | 'cancelled' | null } {
  const q = new URLSearchParams(window.location.search);
  const checkout = q.get('checkout');
  return { orderId: q.get('order'), returnStatus: checkout === 'success' || checkout === 'cancelled' ? checkout : null };
}

export default function CardRoute(props: CardRouteProps) {
  const card = useHolidayCard(props.cardId);
  const { refetch } = card;
  const server = useMemo(() => serverReadFrom(card.view), [card.view]);
  const fetchServer = useCallback(async () => serverReadFrom(await refetch()), [refetch]);
  return (
    <CardEditsProvider cardId={props.cardId} server={server} fetchServer={fetchServer} onSaved={() => void refetch()}>
      <CardRouteBody {...props} card={card} />
    </CardEditsProvider>
  );
}

function CardRouteBody({ cardId, card, renderCheckout, onOrder, onOpenOrder, onOpenOrders, onSignOut }: CardRouteProps & { card: UseHolidayCard }) {
  const edits = useCardEdits();
  const fonts = useCardFonts();
  const hasPastOrders = useHasPastOrders();
  const [initialReturn] = useState(readReturnParams);
  const [view, setView] = useState<'editor' | 'checkout'>(initialReturn.orderId || initialReturn.returnStatus ? 'checkout' : 'editor');
  const [resumeOrderId, setResumeOrderId] = useState<string | null>(initialReturn.orderId);

  const photoProvider: FrontPhotoProvider = useMemo(
    () => createPickerProvider({ fetchPool: (cursor) => fetchPickerPool(cardId, cursor), getUrls: getCardMediaUrls }),
    [cardId],
  );

  const canCheckout = renderCheckout !== undefined;

  if (view === 'checkout' && renderCheckout) {
    return (
      <ChunkErrorBoundary>
        {renderCheckout({
          cardId,
          card,
          edits,
          orderId: resumeOrderId,
          returnStatus: initialReturn.returnStatus,
          onBack: () => {
            setView('editor');
            setResumeOrderId(null);
            // Drop the Stripe return query so a refresh opens the editor.
            const url = new URL(window.location.href);
            url.searchParams.delete('order');
            url.searchParams.delete('checkout');
            window.history.replaceState(null, '', url.pathname + url.search);
            void card.refetch();
          },
        })}
      </ChunkErrorBoundary>
    );
  }

  return (
    <CardEditorScreen
      view={card.view}
      load={card.status}
      error={card.error}
      fontsStatus={fonts.status}
      photoProvider={photoProvider}
      loadFilmUrls={getFilmUrls}
      onRetryLoad={() => void card.refetch()}
      onRetryFonts={fonts.retry}
      onImageError={card.reportImageError}
      onOrder={() => {
        if (canCheckout) {
          setResumeOrderId(null);
          setView('checkout');
        } else onOrder?.();
      }}
      onSignOut={() => void (onSignOut ?? signOut)()}
      onResumeCheckout={
        canCheckout
          ? (orderId) => {
              setResumeOrderId(orderId);
              setView('checkout');
            }
          : undefined
      }
      // Without a host handler, "View" on a past order opens its status in the checkout view.
      onCancelCheckout={async (orderId) => {
        try {
          await cancelCardCheckout(orderId);
        } catch (e) {
          // Already paid, expired or cancelled: the checkout is gone either way.
          if (!(e instanceof CardApiError && isCancelDoneCode(e.code))) throw e;
        }
        // The refetch clears `hasOpenCheckout`, which also reopens editing in the queue.
        await card.refetch();
      }}
      onOpenOrders={hasPastOrders ? onOpenOrders : undefined}
      onOpenOrder={
        onOpenOrder ??
        (canCheckout
          ? (orderId) => {
              setResumeOrderId(orderId);
              setView('checkout');
            }
          : undefined)
      }
    />
  );
}
