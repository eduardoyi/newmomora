import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearNewMemoryDraft,
  getNewMemoryDraftStorageKey,
  isEmptyDraft,
  loadNewMemoryDraft,
  type NewMemoryDraft,
  saveNewMemoryDraft,
} from '@/utils/new-memory-draft';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';

function buildDraft(overrides: Partial<NewMemoryDraft> = {}): NewMemoryDraft {
  return {
    content: 'We went to the park today.',
    taggedMemberIds: ['member-1', 'member-2'],
    memoryDate: '2026-07-16',
    illustrationEnabled: true,
    ...overrides,
  };
}

describe('new-memory draft storage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  it('round-trips a draft', async () => {
    await saveNewMemoryDraft(USER_ID, FAMILY_ID, buildDraft());
    expect(await loadNewMemoryDraft(USER_ID, FAMILY_ID)).toEqual(buildDraft());
  });

  it('scopes the storage key per user and family so different scopes never collide', async () => {
    await saveNewMemoryDraft(USER_ID, FAMILY_ID, buildDraft({ content: 'family A draft' }));
    await saveNewMemoryDraft(USER_ID, 'family-2', buildDraft({ content: 'family B draft' }));
    await saveNewMemoryDraft('user-2', FAMILY_ID, buildDraft({ content: 'other user draft' }));

    expect((await loadNewMemoryDraft(USER_ID, FAMILY_ID))?.content).toBe('family A draft');
    expect((await loadNewMemoryDraft(USER_ID, 'family-2'))?.content).toBe('family B draft');
    expect((await loadNewMemoryDraft('user-2', FAMILY_ID))?.content).toBe('other user draft');

    expect(getNewMemoryDraftStorageKey(USER_ID, FAMILY_ID)).not.toBe(
      getNewMemoryDraftStorageKey(USER_ID, 'family-2'),
    );
    expect(getNewMemoryDraftStorageKey(USER_ID, FAMILY_ID)).not.toBe(
      getNewMemoryDraftStorageKey('user-2', FAMILY_ID),
    );
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadNewMemoryDraft(USER_ID, FAMILY_ID)).toBeNull();
  });

  it('returns null without userId or familyId rather than reading an unscoped key', async () => {
    expect(await loadNewMemoryDraft('', FAMILY_ID)).toBeNull();
    expect(await loadNewMemoryDraft(USER_ID, '')).toBeNull();
  });

  it('clears the stored draft', async () => {
    await saveNewMemoryDraft(USER_ID, FAMILY_ID, buildDraft());
    await clearNewMemoryDraft(USER_ID, FAMILY_ID);
    expect(await loadNewMemoryDraft(USER_ID, FAMILY_ID)).toBeNull();
  });

  it('degrades to null when storage reads fail', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk on fire'));
    expect(await loadNewMemoryDraft(USER_ID, FAMILY_ID)).toBeNull();
  });

  it('degrades to null for corrupted/invalid JSON instead of throwing', async () => {
    await AsyncStorage.setItem(getNewMemoryDraftStorageKey(USER_ID, FAMILY_ID), 'not json{{{');
    expect(await loadNewMemoryDraft(USER_ID, FAMILY_ID)).toBeNull();

    await AsyncStorage.setItem(
      getNewMemoryDraftStorageKey(USER_ID, FAMILY_ID),
      JSON.stringify({ content: 'ok' }), // missing required fields
    );
    expect(await loadNewMemoryDraft(USER_ID, FAMILY_ID)).toBeNull();
  });

  it('swallows storage write failures (autosave is best-effort)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk on fire'));
    await expect(saveNewMemoryDraft(USER_ID, FAMILY_ID, buildDraft())).resolves.toBeUndefined();
  });

  it('swallows storage clear failures', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('disk on fire'));
    await expect(clearNewMemoryDraft(USER_ID, FAMILY_ID)).resolves.toBeUndefined();
  });

  describe('isEmptyDraft', () => {
    it('is empty when content is blank and no members are tagged', () => {
      expect(isEmptyDraft(buildDraft({ content: '   ', taggedMemberIds: [] }))).toBe(true);
    });

    it('is not empty when content has text', () => {
      expect(isEmptyDraft(buildDraft({ content: 'hello', taggedMemberIds: [] }))).toBe(false);
    });

    it('is not empty when members are tagged even with blank content', () => {
      expect(isEmptyDraft(buildDraft({ content: '', taggedMemberIds: ['member-1'] }))).toBe(false);
    });
  });
});
