import { fireEvent, render } from '@testing-library/react-native';

import {
  PortraitTimeline,
  formatPortraitAge,
  type PortraitTimelineVersion,
} from '@/components/portrait-timeline';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import type { FamilyMember } from '@/services/family-members';

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrls: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

jest.mock('@/components/full-screen-media-viewer', () => ({
  FullScreenMediaViewer: ({ items, initialIndex }: { items: unknown[]; initialIndex: number }) => {
    const { Text } = jest.requireActual('react-native') as typeof import('react-native');
    return <Text testID="portrait-fullscreen-mock">{`${initialIndex}:${items.length}`}</Text>;
  },
}));

const mockedUseMediaUrls = useMediaUrls as jest.MockedFunction<typeof useMediaUrls>;

const member = {
  id: 'member-1',
  family_id: 'family-1',
  user_id: 'user-1',
  name: 'Lila',
  date_of_birth: '2022-03-14',
  gender: null,
  additional_info: null,
  nicknames: [],
  is_user_profile: false,
  profile_picture_key: 'legacy/photo.webp',
  illustrated_profile_key: 'legacy/portrait.webp',
  illustrated_profile_status: 'ready',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-05-20T00:00:00Z',
} as FamilyMember;

const ready: PortraitTimelineVersion = {
  id: 'ready-1',
  referenceDate: '2025-11-08',
  dateSource: 'exif',
  status: 'ready',
  sourcePhotoKey: 'user/family/member/portraits/ready-1/photo.jpg',
  portraitKey: 'user/family/member/portraits/ready-1/portrait/attempt.webp',
  createdAt: '2025-11-08T00:00:00Z',
  updatedAt: '2025-11-08T00:00:00Z',
};

const failed: PortraitTimelineVersion = {
  id: 'failed-1',
  referenceDate: '2026-05-20',
  dateSource: 'default_today',
  status: 'failed',
  sourcePhotoKey: 'user/family/member/portraits/failed-1/photo.jpg',
  portraitKey: null,
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

const baseProps = {
  member,
  versions: [failed, ready],
  currentVersionId: ready.id,
  canEdit: true,
  onBack: jest.fn(),
  onPickPhoto: jest.fn(async () => null),
  onCreate: jest.fn(async () => undefined),
  onEditDate: jest.fn(async () => undefined),
  onRetry: jest.fn(async () => undefined),
  onRegenerate: jest.fn(async () => undefined),
  onDelete: jest.fn(async () => undefined),
};

describe('formatPortraitAge', () => {
  it('formats a child age at the portrait reference date', () => {
    expect(formatPortraitAge('2022-03-14', '2025-11-08')).toBe('3 years, 7 months');
  });

  it('returns null when either date is unavailable', () => {
    expect(formatPortraitAge(null, '2025-11-08')).toBeNull();
    expect(formatPortraitAge('2022-03-14', null)).toBeNull();
  });
});

describe('PortraitTimeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseMediaUrls.mockImplementation((keys) => ({
      data: Object.fromEntries(keys.map((key) => [key, `https://media.test/${encodeURIComponent(key)}`])),
      isLoading: false,
      isError: false,
    }) as ReturnType<typeof useMediaUrls>);
  });

  it('renders paired versions, source provenance, current badge, and failed retry', () => {
    const { getByTestId, getByText } = render(<PortraitTimeline {...baseProps} />);

    expect(getByText('Then & now')).toBeTruthy();
    expect(getByText('2 portraits · how Lila has looked over time')).toBeTruthy();
    expect(getByTestId('portrait-version-ready-1-current')).toBeTruthy();
    expect(getByTestId('portrait-source-exif')).toBeTruthy();
    expect(getByTestId('portrait-version-failed-1-retry')).toBeTruthy();
    expect(mockedUseMediaUrls).toHaveBeenCalledWith([
      ready.sourcePhotoKey,
      ready.portraitKey,
    ]);
  });

  it('uses the date-and-age card as the only date picker trigger', () => {
    const { getAllByTestId, getByTestId, queryByText } = render(
      <PortraitTimeline {...baseProps} />,
    );

    fireEvent.press(getByTestId('portrait-version-ready-1-actions'));
    fireEvent.press(getByTestId('portrait-action-edit-date'));

    expect(getAllByTestId('portrait-date-picker')).toHaveLength(1);
    expect(getByTestId('portrait-date-edit-icon')).toBeTruthy();
    expect(queryByText('Set the date')).toBeNull();
  });

  it('opens both source photo and portrait in the paired full-screen viewer', () => {
    const { getByTestId } = render(<PortraitTimeline {...baseProps} />);

    fireEvent.press(getByTestId('portrait-version-ready-1-portrait'));

    expect(getByTestId('portrait-fullscreen-mock').props.children).toBe('1:2');
  });

  it('keeps viewer access read-only', () => {
    const { queryByTestId, getByText } = render(
      <PortraitTimeline {...baseProps} canEdit={false} />,
    );

    expect(queryByTestId('portrait-timeline-add')).toBeNull();
    expect(queryByTestId('portrait-version-ready-1-actions')).toBeNull();
    expect(queryByTestId('portrait-version-failed-1-retry')).toBeNull();
    expect(getByText('Family managers can add and update portraits.')).toBeTruthy();
  });

  it('welcomes backdated photos and protects the sole timeline record', () => {
    const { getByTestId, getByText } = render(
      <PortraitTimeline {...baseProps} currentVersionId={null} versions={[failed]} />,
    );

    fireEvent.press(getByTestId('portrait-timeline-add'));
    expect(getByText('Add a current or older photo to capture how Lila looked at that time.')).toBeTruthy();
    fireEvent.press(getByTestId('portrait-version-failed-1-actions'));

    const deleteAction = getByTestId('portrait-action-delete');
    expect(deleteAction.props.accessibilityState.disabled).toBe(true);
    expect(getByText('Lila’s only timeline record — can’t be removed')).toBeTruthy();
  });

  it('protects the last usable portrait when other versions have failed', () => {
    const { getByTestId, getByText } = render(<PortraitTimeline {...baseProps} />);

    fireEvent.press(getByTestId('portrait-version-ready-1-actions'));

    const deleteAction = getByTestId('portrait-action-delete');
    expect(deleteAction.props.accessibilityState.disabled).toBe(true);
    expect(getByText('Keep at least one finished portrait before removing this one')).toBeTruthy();
  });

  it('restores a recovered Android picker result into date confirmation', () => {
    const { getAllByTestId, getByTestId, getByText } = render(
      <PortraitTimeline
        {...baseProps}
        recoveredPhotoDraft={{
          uri: 'file:///recovered.jpg',
          contentType: 'image/jpeg',
          referenceDate: '2024-02-03',
          dateSource: 'exif',
        }}
      />,
    );

    expect(getByTestId('portrait-date-sheet')).toBeTruthy();
    expect(getByText(/February.*3.*2024|3.*February.*2024/)).toBeTruthy();
    expect(getAllByTestId('portrait-source-exif').length).toBeGreaterThan(1);
  });
});
