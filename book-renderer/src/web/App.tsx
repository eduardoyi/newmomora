import { useAuthSession } from './auth/useAuthSession';
import { LoginScreen } from './auth/LoginScreen';
import { BookListScreen } from './books/BookListScreen';
import { BookViewScreen } from './book/BookViewScreen';
import { useRouter } from './router';
import { getFixtureSlug } from './dev/fixture';

export function App() {
  // DEV-ONLY fixture mode (owner-approved follow-up round, "diagnose
  // live"): `?fixture=<slug>` renders that book directly, bypassing auth
  // AND the router entirely — there is no Supabase session in fixture mode,
  // so gating on one would just dead-end at `LoginScreen`. Checked ahead of
  // `useAuthSession()` so no session round-trip even starts. Dead code in a
  // production build — see `dev/fixture.ts`'s header comment.
  if (import.meta.env.DEV) {
    const fixtureSlug = getFixtureSlug();
    if (fixtureSlug) {
      return <BookViewScreen bookId={fixtureSlug} onBack={() => {}} />;
    }
  }

  return <AuthenticatedApp />;
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
    return <BookViewScreen bookId={route.bookId} onBack={() => navigate('/')} />;
  }

  return <BookListScreen onOpenBook={(bookId) => navigate(`/b/${bookId}`)} />;
}
