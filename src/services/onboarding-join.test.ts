import AsyncStorage from '@react-native-async-storage/async-storage';

import { getJoinDraft, patchJoinDraft } from '@/services/onboarding-join';

const KEY = 'momora.joinDraft';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('join draft', () => {
  it('accepts a string inviteeName', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ inviterName: 'Sam', inviteeName: 'Ana' }));

    expect(await getJoinDraft()).toEqual({ inviterName: 'Sam', inviteeName: 'Ana' });
  });

  it('keeps the rest of the draft when inviteeName is null', async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ displayName: 'Grandma Ana', inviterName: 'Sam', inviteeName: null }),
    );

    expect(await getJoinDraft()).toEqual({
      displayName: 'Grandma Ana',
      inviterName: 'Sam',
      inviteeName: null,
    });
  });

  it('still wipes the draft when a field has the wrong type', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ inviterName: 'Sam', inviteeName: 42 }));

    expect(await getJoinDraft()).toEqual({});
  });

  it('patching inviteeName to undefined clears the stored key but keeps other fields', async () => {
    await patchJoinDraft({ inviterName: 'Sam', inviteeName: 'Ana' });
    await patchJoinDraft({ inviteeName: undefined });

    expect(JSON.parse((await AsyncStorage.getItem(KEY)) as string)).toEqual({ inviterName: 'Sam' });
  });
});
