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

const incompleteMember = {
  ...member,
  id: 'member-2',
  name: 'Enzo',
  date_of_birth: null,
  profile_picture_key: null,
  illustrated_profile_key: null,
  illustrated_profile_status: 'pending',
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

  it('opens the portrait timeline from the contextual history action', () => {
    const onPortraitTimelinePress = jest.fn();
    const { getByLabelText, getByTestId, queryByText } = render(
      <CastCard
        member={member}
        onPortraitTimelinePress={onPortraitTimelinePress}
        portraitCount={4}
      />,
    );

    expect(getByLabelText('Open portrait timeline, 4 portraits')).toBeTruthy();
    expect(queryByText('4')).toBeNull();
    fireEvent.press(getByTestId('family-member-portrait-history'));

    expect(onPortraitTimelinePress).toHaveBeenCalledTimes(1);
  });

  it('shows a quiet complete-profile prompt instead of age/nicknames for a name-only kid, for an editor', () => {
    const { getByTestId, queryByText } = render(
      <CastCard canEdit member={incompleteMember} />,
    );

    expect(getByTestId('family-member-incomplete-member-2').props.children).toBe(
      "Tap to add Enzo's birthday & photo",
    );
    expect(queryByText('2022-01-01')).toBeNull();
  });

  it('does not show the incomplete prompt once DOB and a photo are both present', () => {
    const { queryByTestId } = render(<CastCard canEdit member={member} />);

    expect(queryByTestId('family-member-incomplete-member-1')).toBeNull();
  });

  it('treats an in-progress portrait as complete when a DOB and source photo exist', () => {
    const { queryByTestId } = render(
      <CastCard
        canEdit
        member={{
          ...member,
          illustrated_profile_key: null,
          illustrated_profile_status: 'generating',
        }}
      />,
    );

    expect(queryByTestId('family-member-incomplete-member-1')).toBeNull();
  });

  it('names only the missing field when just the photo is missing', () => {
    const { getByTestId } = render(
      <CastCard
        canEdit
        member={{
          ...incompleteMember,
          date_of_birth: '2022-01-01',
        }}
      />,
    );

    expect(getByTestId('family-member-incomplete-member-2').props.children).toBe(
      "Tap to add Enzo's photo",
    );
  });

  it('suppresses the incomplete-profile prompt for a viewer (canEdit=false) -- never asserts an action the app can\'t deliver', () => {
    const { queryByTestId, queryByText } = render(
      <CastCard canEdit={false} member={incompleteMember} />,
    );

    expect(queryByTestId('family-member-incomplete-member-2')).toBeNull();
    expect(queryByText(/Tap to add/)).toBeNull();
  });

  it('defaults canEdit to false when the prop is omitted -- fails closed, not open', () => {
    const { queryByTestId } = render(<CastCard member={incompleteMember} />);

    expect(queryByTestId('family-member-incomplete-member-2')).toBeNull();
  });
});
