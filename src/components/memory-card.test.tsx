import { render } from '@testing-library/react-native';

import { MemoryCard } from '@/components/memory-card';
import type { MemoryWithTags } from '@/services/memories';

jest.mock('@/components/family-member-avatar', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');

  return {
    FamilyMemberAvatar: ({ member, testID }: { member: { name: string }; testID: string }) => (
      <Text testID={testID}>{member.name}</Text>
    ),
  };
});

jest.mock('@/components/memory-engagement-bar', () => ({
  MemoryEngagementBar: () => null,
}));

jest.mock('@/components/memory-media-carousel', () => ({
  MemoryMediaCarousel: () => null,
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: () => ({ url: null }),
}));

const createMember = (index: number) => ({
  id: `member-${index}`,
  user_id: 'user-1',
  family_id: 'family-1',
  name: `Member ${index}`,
  nicknames: [],
  date_of_birth: null,
  gender: null,
  profile_picture_key: null,
  illustrated_profile_key: null,
  illustrated_profile_status: 'ready',
  additional_info: null,
  is_user_profile: false,
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
});

const createMemory = (memberCount: number) => ({
  id: 'memory-1',
  user_id: 'user-1',
  family_id: 'family-1',
  content: 'A family memory',
  memory_date: '2026-07-14',
  memory_type: 'text_only',
  emotion: null,
  illustration_key: null,
  illustration_status: 'none',
  illustration_prompt: null,
  media_key: null,
  media_content_type: null,
  link_previews: {},
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
  taggedMembers: Array.from({ length: memberCount }, (_, index) => createMember(index + 1)),
  mediaAssets: [],
  likeCount: 0,
  commentCount: 0,
  likedByMe: false,
}) as MemoryWithTags;

describe('MemoryCard tagged member avatars', () => {
  it('shows all six tagged members without an overflow indicator', () => {
    const { getByTestId, queryByTestId } = render(
      <MemoryCard
        memory={createMemory(6)}
        onOpenComments={jest.fn()}
        onPress={jest.fn()}
      />,
    );

    expect(getByTestId('memory-card-member-member-6')).toBeTruthy();
    expect(queryByTestId('memory-card-member-overflow')).toBeNull();
  });

  it('shows six tagged members and a count for the remaining members', () => {
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <MemoryCard
        memory={createMemory(8)}
        onOpenComments={jest.fn()}
        onPress={jest.fn()}
      />,
    );

    expect(getByTestId('memory-card-member-member-6')).toBeTruthy();
    expect(queryByTestId('memory-card-member-member-7')).toBeNull();
    expect(getByTestId('memory-card-member-overflow')).toHaveTextContent('+2');
    expect(getByLabelText('2 more tagged members')).toBeTruthy();
  });
});
