import { fireEvent, render } from '@testing-library/react-native';

import { CastCard } from '@/components/cast-card';

jest.mock('@/components/family-profile-portrait-photo', () => ({
  FamilyProfilePortraitPhoto: 'FamilyProfilePortraitPhoto',
}));

const member = {
  id: 'member-1',
  user_id: 'user-1',
  family_id: 'family-1',
  name: 'Mara',
  nicknames: [],
  date_of_birth: '2022-01-01',
  gender: null,
  profile_picture_key: 'user-1/family/member-1/profile.jpg',
  illustrated_profile_key: 'user-1/family/member-1/portrait.webp',
  illustrated_profile_status: 'ready',
  additional_info: null,
  is_user_profile: false,
  created_at: '2026-07-12T00:00:00.000Z',
  updated_at: '2026-07-12T00:00:00.000Z',
};

describe('CastCard', () => {
  it('opens a ready portrait when its portrait area is pressed', () => {
    const onPortraitPress = jest.fn();
    const { getByTestId } = render(
      <CastCard member={member} onPortraitPress={onPortraitPress} />,
    );

    fireEvent.press(getByTestId('family-member-portrait'));

    expect(onPortraitPress).toHaveBeenCalledTimes(1);
  });
});
