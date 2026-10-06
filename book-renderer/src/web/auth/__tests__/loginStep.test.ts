import { describe, expect, it } from 'vitest';
import { clearLoginStep, loadLoginStep, LOGIN_STEP_STORAGE_KEY, saveLoginStep } from '../loginStep';
import { friendlyAuthError, loginCopyForPath, parseWaitSeconds } from '../authCopy';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe('login step persistence', () => {
  it('round-trips the code step (a reload resumes at the code step)', () => {
    const storage = fakeStorage();
    saveLoginStep(storage, { kind: 'code', email: 'jane@example.test' });
    expect(loadLoginStep(storage)).toEqual({ kind: 'code', email: 'jane@example.test' });
  });

  it('defaults to the email step when nothing / garbage is stored', () => {
    expect(loadLoginStep(fakeStorage())).toEqual({ kind: 'email' });
    expect(loadLoginStep(fakeStorage({ [LOGIN_STEP_STORAGE_KEY]: '{not json' }))).toEqual({ kind: 'email' });
    expect(loadLoginStep(fakeStorage({ [LOGIN_STEP_STORAGE_KEY]: JSON.stringify({ kind: 'code' }) }))).toEqual({ kind: 'email' });
    expect(loadLoginStep(fakeStorage({ [LOGIN_STEP_STORAGE_KEY]: JSON.stringify({ kind: 'code', email: '' }) }))).toEqual({ kind: 'email' });
    expect(loadLoginStep(null)).toEqual({ kind: 'email' });
  });

  it('saving the email step and clearing both remove the stored value', () => {
    const storage = fakeStorage();
    saveLoginStep(storage, { kind: 'code', email: 'jane@example.test' });
    saveLoginStep(storage, { kind: 'email' });
    expect(storage.map.size).toBe(0);
    saveLoginStep(storage, { kind: 'code', email: 'jane@example.test' });
    clearLoginStep(storage);
    expect(storage.map.size).toBe(0);
  });

  it('never throws when storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadLoginStep(throwing)).toEqual({ kind: 'email' });
    expect(() => saveLoginStep(throwing, { kind: 'code', email: 'a@b.test' })).not.toThrow();
    expect(() => clearLoginStep(throwing)).not.toThrow();
  });
});

describe('friendlyAuthError', () => {
  it('turns GoTrue\'s "request this after N seconds" into friendly copy + a wait', () => {
    const raw = 'For security purposes, you can only request this after 47 seconds.';
    expect(parseWaitSeconds(raw)).toBe(47);
    const friendly = friendlyAuthError(raw);
    expect(friendly.waitSeconds).toBe(47);
    expect(friendly.message).toContain('47 seconds');
    expect(friendly.message).not.toMatch(/security purposes/i);
  });

  it('handles the singular and passes other messages through', () => {
    expect(friendlyAuthError('you can only request this after 1 second').message).toContain('1 second,');
    expect(friendlyAuthError('Token has expired or is invalid')).toEqual({
      message: 'Token has expired or is invalid',
      waitSeconds: null,
    });
    expect(friendlyAuthError('email rate limit exceeded').waitSeconds).toBeNull();
  });
});

describe('loginCopyForPath', () => {
  it('says holiday card on /c/ paths and Memory Book elsewhere', () => {
    expect(loginCopyForPath('/c/abc').title).toBe('Sign in to your holiday card');
    expect(loginCopyForPath('/c/abc').hint).toContain('holiday card');
    expect(loginCopyForPath('/b/abc').title).toBe('Sign in to your Memory Book');
    expect(loginCopyForPath('/').title).toBe('Sign in to your Memory Book');
    expect(loginCopyForPath('/cards').title).toBe('Sign in to your Memory Book');
  });
});
