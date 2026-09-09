import { useAuthSession } from './auth/useAuthSession';
import { LoginScreen } from './auth/LoginScreen';
import { BookListScreen } from './books/BookListScreen';
import { BookViewScreen } from './book/BookViewScreen';
import { OrderStatusScreen } from './order/OrderStatusScreen';
import { OrdersListScreen } from './order/OrdersListScreen';
import { useRouter } from './router';
import { getFixtureSlug } from './dev/fixture';

export function App() {
  // DEV-ONLY fixture mode (owner-approved follow-up round, "diagnose
  // live"): `?fixture=<slug>` renders that book directly, bypassing auth
  // entirely — there is no Supabase session in fixture mode, so gating on
  // one would just dead-end at `LoginScreen`. Checked ahead of
  // `useAuthSession()` so no session round-trip even starts. Dead code in a
  // production build — see `dev/fixture.ts`'s header comment.
  if (import.meta.env.DEV) {
    const fixtureSlug = getFixtureSlug();
    if (fixtureSlug) {
      return <FixtureApp bookId={fixtureSlug} />;
    }
  }

  return <AuthenticatedApp />;
}

/**
 * DEV-ONLY fixture-mode shell (memory-book-5c plan Step 6: "extend [fixture
 * mode] to mock the orders ops so the whole flow is interactively
 * verifiable without money"). Unlike the pre-5c version of this branch —
 * which rendered `BookViewScreen` directly and bypassed the router entirely
 * — this now uses the SAME `useRouter` hook `AuthenticatedApp` does, so
 * `BookViewScreen`'s "Order this book" → `CheckoutScreen` → `/order/<id>`
 * in-app navigation is exercised end-to-end. `bookId` stays fixed to the
 * fixture slug App() resolved at mount (see that function's own comment on
 * why a URL change from `navigate()` never re-triggers this branch) — only
 * `route` (from `window.location.pathname`) determines which screen shows.
 */
function FixtureApp({ bookId }: { bookId: string }) {
  const [route, navigate] = useRouter();

  // `navigate()` does a plain `pushState(null, '', path)` — it REPLACES the
  // whole URL, dropping `?fixture=<slug>` along with it. `getFixtureSlug()`
  // re-reads `window.location.search` on every call (not just once at
  // `App()`'s mount — `ordersApi.ts`/`useOrderStatus.ts` both call it fresh
  // per operation), so losing the param mid-flow would silently fall through
  // to REAL Supabase calls from inside what's supposed to still be fixture
  // mode. Every in-fixture-app navigation must re-append it.
  function navigateInFixture(path: string) {
    navigate(`${path}?fixture=${encodeURIComponent(bookId)}`);
  }

  if (route.screen === 'order') {
    return (
      <OrderStatusScreen orderId={route.orderId} onBackToBook={(backBookId) => navigateInFixture(`/b/${backBookId}`)} />
    );
  }

  if (route.screen === 'orders') {
    return (
      <OrdersListScreen
        onOpenOrder={(orderId) => navigateInFixture(`/order/${orderId}`)}
        onBack={() => navigateInFixture(`/b/${bookId}`)}
      />
    );
  }

  return (
    <BookViewScreen
      bookId={bookId}
      onBack={() => {}}
      onOrderPlaced={(orderId) => navigateInFixture(`/order/${orderId}`)}
      onOpenOrders={() => navigateInFixture('/orders')}
    />
  );
}

function AuthenticatedApp() {
  const { session, loading } = useAuthSession();
  const [route, navigate] = useRouter();

  if (loading) {
    return (
      <div className="app-boot">
        <p>Loading…</p>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  if (route.screen === 'book') {
    return (
      <BookViewScreen
        bookId={route.bookId}
        onBack={() => navigate('/')}
        onOrderPlaced={(orderId) => navigate(`/order/${orderId}`)}
        onOpenOrders={() => navigate('/orders')}
      />
    );
  }

  if (route.screen === 'order') {
    return <OrderStatusScreen orderId={route.orderId} onBackToBook={(bookId) => navigate(`/b/${bookId}`)} />;
  }

  if (route.screen === 'orders') {
    return <OrdersListScreen onOpenOrder={(orderId) => navigate(`/order/${orderId}`)} onBack={() => navigate('/')} />;
  }

  return <BookListScreen onOpenBook={(bookId) => navigate(`/b/${bookId}`)} onOpenOrders={() => navigate('/orders')} />;
}
