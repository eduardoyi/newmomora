import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { accountNote } from '../accountNote';
import { hasHeader, registerHeader, subscribeHeaderPresence } from '../headerPresence';
import { ShopHeader } from '../ShopHeader';

describe('ShopHeader (presentational)', () => {
  const base = { onHome: () => {}, onSignOut: () => {} };
  it('has the wordmark link home, Your orders and Sign out', () => {
    const html = renderToStaticMarkup(<ShopHeader {...base} onOrders={() => {}} />);
    expect(html).toContain('href="/"');
    expect(html).toContain('Your orders');
    expect(html).toContain('Sign out');
    expect(html).not.toContain('← Home');
  });
  it('shows "← Home" on request, and hides "Your orders" when no handler is given', () => {
    const html = renderToStaticMarkup(<ShopHeader {...base} showBack />);
    expect(html).toContain('← Home');
    expect(html).not.toContain('Your orders');
    expect(html).toContain('Sign out');
  });
  it('folds the handoff line into the header', () => {
    const html = renderToStaticMarkup(<ShopHeader {...base} account={{ message: 'Signed in as j•••@example.test', actionLabel: 'Not you?', onAction: () => {} }} />);
    expect(html).toContain('Signed in as j•••@example.test');
    expect(html).toContain('Not you?');
  });
});

describe('accountNote', () => {
  const me = { userId: 'u1', email: 'me@example.test' };
  it('shows "Signed in as … · Not you?" only for the handoff\'s own user', () => {
    expect(accountNote({ phase: 'signedIn', maskedEmail: 'm•••@example.test', userId: 'u1' }, me)).toEqual({ kind: 'signedIn', message: 'Signed in as m•••@example.test', actionLabel: 'Not you?' });
    expect(accountNote({ phase: 'signedIn', maskedEmail: 'm•••@example.test', userId: 'u2' }, me)).toBeNull();
  });
  it('a failed handoff while signed in says who you still are', () => {
    expect(accountNote({ phase: 'failed' }, me)).toEqual({ kind: 'failed', message: "That sign-in link expired — you're still signed in as me@example.test.", actionLabel: 'Dismiss' });
    expect(accountNote({ phase: 'failed' }, { userId: 'u1', email: null })?.message).toBe("That sign-in link expired — you're still signed in.");
  });
  it('nothing without a session or a handoff', () => {
    expect(accountNote({ phase: 'idle' }, me)).toBeNull();
    expect(accountNote({ phase: 'signedIn', maskedEmail: 'x', userId: 'u1' }, null)).toBeNull();
  });
});

describe('header presence (hides the floating chip)', () => {
  it('counts mounted headers and notifies', () => {
    const listener = vi.fn();
    const off = subscribeHeaderPresence(listener);
    expect(hasHeader()).toBe(false);
    const unregister = registerHeader();
    expect(hasHeader()).toBe(true);
    unregister();
    expect(hasHeader()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});
