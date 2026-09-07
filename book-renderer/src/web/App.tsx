import { useAuthSession } from './auth/useAuthSession';
import { LoginScreen } from './auth/LoginScreen';
import { BookListScreen } from './books/BookListScreen';
import { BookViewScreen } from './book/BookViewScreen';
import { useRouter } from './router';

export function App() {
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
