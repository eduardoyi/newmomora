import { Linking } from 'react-native';

import { invokeEdgeFunction } from '@/services/ai';
import {
  isShopUrl,
  openShopUrl,
  resetWebHandoffForTests,
  WEB_HANDOFF_TIMEOUT_MS,
} from '@/services/web-handoff';

jest.mock('@/services/ai', () => ({
  invokeEdgeFunction: jest.fn(),
}));

const mockedInvoke = invokeEdgeFunction as jest.MockedFunction<typeof invokeEdgeFunction>;
const CODE = 'Ab-_'.repeat(10) + 'Abc'; // 43 base64url chars incl. '-' and '_'
const SHOP_URL = 'https://shop.usemomora.com/b/book-1';

let openURL: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  resetWebHandoffForTests();
  mockedInvoke.mockReset();
  openURL = jest.spyOn(Linking, 'openURL');
  openURL.mockReset();
  openURL.mockResolvedValue(true as never);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('isShopUrl', () => {
  it('accepts only https://shop.usemomora.com/...', () => {
    expect(isShopUrl(SHOP_URL)).toBe(true);
    expect(isShopUrl('https://shop.usemomora.com/c/card-1')).toBe(true);
    expect(isShopUrl('http://shop.usemomora.com/b/1')).toBe(false);
    expect(isShopUrl('https://shop.usemomora.com.evil.test/b/1')).toBe(false);
    expect(isShopUrl('https://shop.usemomora.com@evil.test/b/1')).toBe(false);
    expect(isShopUrl('https://usemomora.com/b/1')).toBe(false);
    expect(isShopUrl('https://shop.usemomora.com')).toBe(false);
  });
});

describe('openShopUrl', () => {
  it('opens non-shop URLs as-is without asking for a code', async () => {
    await openShopUrl('https://example.test/page');
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(openURL).toHaveBeenCalledWith('https://example.test/page');
  });

  it('opens the shop URL with #h=<code> when create succeeds', async () => {
    mockedInvoke.mockResolvedValue({ data: { code: CODE }, error: null });
    await openShopUrl(SHOP_URL);
    expect(mockedInvoke).toHaveBeenCalledWith('web-handoff', { op: 'create' });
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(`${SHOP_URL}#h=${CODE}`);
  });

  it('falls back to the plain URL when create returns an error', async () => {
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'nope', code: '429' } });
    await openShopUrl(SHOP_URL);
    expect(openURL).toHaveBeenCalledWith(SHOP_URL);
  });

  it('falls back to the plain URL when create throws', async () => {
    mockedInvoke.mockRejectedValue(new Error('network down'));
    await openShopUrl(SHOP_URL);
    expect(openURL).toHaveBeenCalledWith(SHOP_URL);
  });

  it('falls back to the plain URL for a malformed code', async () => {
    mockedInvoke.mockResolvedValue({ data: { code: 'short' }, error: null });
    await openShopUrl(SHOP_URL);
    expect(openURL).toHaveBeenCalledWith(SHOP_URL);
  });

  it('falls back to the plain URL after the 3 s timeout and ignores a late code', async () => {
    let resolveCreate: (value: { data: { code: string }; error: null }) => void = () => {};
    mockedInvoke.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve as typeof resolveCreate;
      }),
    );
    const opened = openShopUrl(SHOP_URL);
    await jest.advanceTimersByTimeAsync(WEB_HANDOFF_TIMEOUT_MS - 1);
    expect(openURL).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);
    await opened;
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(SHOP_URL);

    resolveCreate({ data: { code: CODE }, error: null });
    await jest.advanceTimersByTimeAsync(10);
    expect(openURL).toHaveBeenCalledTimes(1);
  });

  it('a double tap opens one tab and asks for one code', async () => {
    let resolveCreate: (value: { data: { code: string }; error: null }) => void = () => {};
    mockedInvoke.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve as typeof resolveCreate;
      }),
    );
    const first = openShopUrl(SHOP_URL);
    const second = openShopUrl(SHOP_URL);
    resolveCreate({ data: { code: CODE }, error: null });
    await Promise.all([first, second]);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(`${SHOP_URL}#h=${CODE}`);
  });

  it('allows a new handoff after the previous one settled', async () => {
    mockedInvoke.mockResolvedValue({ data: { code: CODE }, error: null });
    await openShopUrl(SHOP_URL);
    await openShopUrl(SHOP_URL);
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(openURL).toHaveBeenCalledTimes(2);
  });

  it('does not append a code to a URL that already has a fragment', async () => {
    await openShopUrl(`${SHOP_URL}#section`);
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(openURL).toHaveBeenCalledWith(`${SHOP_URL}#section`);
  });
});
