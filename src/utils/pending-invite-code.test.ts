import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearPendingInviteCode,
  getPendingInviteCode,
  PENDING_INVITE_CODE_STORAGE_KEY,
  setPendingInviteCode,
} from '@/utils/pending-invite-code';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('pending invite code storage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  it('round-trips a code', async () => {
    await setPendingInviteCode('sunny-tiger-lake');
    expect(await getPendingInviteCode()).toBe('sunny-tiger-lake');
  });

  it('normalizes before storing', async () => {
    await setPendingInviteCode('  Sunny  Tiger--Lake ');
    expect(await AsyncStorage.getItem(PENDING_INVITE_CODE_STORAGE_KEY)).toBe('sunny-tiger-lake');
  });

  it('does not store an empty/blank code', async () => {
    await setPendingInviteCode('   ');
    expect(await getPendingInviteCode()).toBeNull();
  });

  it('returns null when nothing is stored', async () => {
    expect(await getPendingInviteCode()).toBeNull();
  });

  it('clears the stored code', async () => {
    await setPendingInviteCode('sunny-tiger-lake');
    await clearPendingInviteCode();
    expect(await getPendingInviteCode()).toBeNull();
  });

  it('degrades to null when storage reads fail', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk on fire'));
    expect(await getPendingInviteCode()).toBeNull();
  });

  it('swallows storage write failures (prefill is best-effort)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk on fire'));
    await expect(setPendingInviteCode('sunny-tiger-lake')).resolves.toBeUndefined();
  });
});
