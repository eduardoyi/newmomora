import { useState } from 'react';
import type { FilmUrls, HolidayCardView } from './cardTypes';

/**
 * The film the card's QR code opens: a note while it renders, a small player
 * once it is ready (signed URLs are fetched on demand, they last 15 minutes),
 * a plain note when it cannot be shown.
 */
export function FilmPanel({
  film,
  loadFilmUrls,
}: {
  film: HolidayCardView['film'];
  loadFilmUrls: (filmId: string) => Promise<FilmUrls>;
}) {
  const [urls, setUrls] = useState<FilmUrls | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  if (film.state === 'none') return null;

  async function load() {
    if (!film.filmId) return;
    setState('loading');
    try {
      setUrls(await loadFilmUrls(film.filmId));
      setState('idle');
    } catch {
      setState('error');
    }
  }

  return (
    <section className="ce-film" aria-label="Your film">
      <h2 className="ce-film__title">Your film</h2>
      {film.state === 'rendering' && <p className="ce-film__note">Your film is still being made. It can take a little while, and you can keep editing meanwhile.</p>}
      {film.state === 'blocked' && <p className="ce-film__note">This film is not available because some of its photos were removed.</p>}
      {film.state === 'failed' && <p className="ce-film__note">We could not make the film this time.</p>}
      {film.state === 'ready' && !urls && (
        <>
          <p className="ce-film__note">This is the film people see when they scan the QR code on the card.</p>
          <button type="button" className="ce-btn ce-btn--ghost" onClick={() => void load()} disabled={state === 'loading' || !film.filmId}>
            {state === 'loading' ? 'Loading…' : 'Watch the film'}
          </button>
          {state === 'error' && <p className="ce-film__note ce-film__note--warn">We could not load the film just now. Try again in a moment.</p>}
        </>
      )}
      {film.state === 'ready' && urls && (
        <video className="ce-film__video" src={urls.videoUrl} poster={urls.posterUrl ?? undefined} controls playsInline preload="metadata" />
      )}
    </section>
  );
}
