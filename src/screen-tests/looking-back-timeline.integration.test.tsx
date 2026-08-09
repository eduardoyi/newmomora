import { fireEvent, render } from '@testing-library/react-native';

const mockUseFamily = jest.fn();
const mockUseFamilyMembers = jest.fn();
const mockUseOnboardingStatus = jest.fn();
const mockUseMemories = jest.fn();
const mockUseContentSafety = jest.fn();
const mockUseLookingBackPackages = jest.fn();
const mockUseLookingBackSession = jest.fn();
const mockIsUserBlocked = jest.fn(() => false);
const mockIsTargetReported = jest.fn(() => false);

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/hooks/use-family', () => ({ useFamily: () => mockUseFamily() }));
jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: () => mockUseFamilyMembers(), useOnboardingStatus: () => mockUseOnboardingStatus(),
}));
jest.mock('@/hooks/useMemories', () => ({ useMemories: () => mockUseMemories() }));
jest.mock('@/hooks/useContentSafety', () => ({ useContentSafety: () => mockUseContentSafety() }));
jest.mock('@/hooks/useLookingBackPackages', () => ({ useLookingBackPackages: () => mockUseLookingBackPackages() }));
jest.mock('@/hooks/useLookingBackSession', () => ({ useLookingBackSession: () => mockUseLookingBackSession() }));
jest.mock('@/components/memory-card', () => ({ MemoryCard: () => null }));
jest.mock('@/components/memory-fab', () => ({ MemoryFab: () => null }));
jest.mock('@/components/content-hidden-notice', () => ({ ContentHiddenNotice: () => null }));
jest.mock('@/components/pending-memory-uploads-banner', () => ({ PendingMemoryUploadsBanner: () => null }));
jest.mock('@/components/looking-back/package-rail', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable: NativePressable, Text: NativeText, View: NativeView } = require('react-native');
  return {
    LookingBackPackageRail: ({ packages, onOpen }: { packages: { id: string; view: { firstViewedAt: string | null }; memories?: unknown[] }[]; onOpen: (id: string, geometry: null) => void }) => packages.length
      ? React.createElement(NativeView, { testID: 'looking-back-rail' },
        React.createElement(NativeText, null, packages[0].view.firstViewedAt ? 'Revisited today' : `${packages[0].memories?.length ?? 0} memories`),
        React.createElement(NativePressable, { testID: 'open-looking-back-package', onPress: () => onOpen(packages[0].id, null) }),
      )
      : null,
  };
});

// eslint-disable-next-line import/first
import TimelineScreen from '../../app/(app)/(tabs)/timeline';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockRouter = require('expo-router').router as { push: jest.Mock };

const timelineMemory = {
  id: 'recent-memory', content: 'Recent', memory_date: '2026-08-08', memory_type: 'text_only', emotion: 'joy',
  taggedMembers: [], mediaAssets: [], likeCount: 0, commentCount: 0, likedByMe: false,
};
const lookingBackPackage = {
  id: 'package-1', familyId: 'family-a', dailySetId: 'set-a', packageType: 'archive_mix',
  displayKind: 'From your archive', title: 'A little while ago', era: '2024', tint: 'joy',
  memories: [{ ...timelineMemory, id: 'old-1' }, { ...timelineMemory, id: 'old-2' }, { ...timelineMemory, id: 'old-3' }, { ...timelineMemory, id: 'old-4' }],
  view: { firstViewedAt: '2026-08-08T09:00:00.000Z' },
};

describe('Timeline Looking Back rail integration', () => {
  let mockSavePackageSnapshot: jest.Mock;
  let mockClearCheckpoint: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFamily.mockReturnValue({ familyId: 'family-a', role: 'owner' });
    mockUseFamilyMembers.mockReturnValue({ members: [{ id: 'child-1' }], isLoading: false });
    mockUseOnboardingStatus.mockReturnValue({ isLoading: false, needsFamilyMember: false });
    mockUseMemories.mockReturnValue({
      memories: [timelineMemory], isLoading: false, isRefetching: false, isError: false, error: null,
      refetch: jest.fn(), fetchNextPage: jest.fn(), isFetchingNextPage: false,
    });
    // Return a new hook wrapper on every render: the Timeline's derived
    // memory list must retain identity across unrelated active-video state.
    mockUseContentSafety.mockImplementation(() => ({
      isUserBlocked: mockIsUserBlocked, isTargetReported: mockIsTargetReported, revealTarget: jest.fn(),
    }));
    mockUseLookingBackPackages.mockReturnValue({ packages: [lookingBackPackage], refetch: jest.fn() });
    mockSavePackageSnapshot = jest.fn();
    mockClearCheckpoint = jest.fn();
    mockUseLookingBackSession.mockReturnValue({
      clearCheckpoint: mockClearCheckpoint,
      savePackageSnapshot: mockSavePackageSnapshot,
    });
  });

  it('orders date, title, This week, Looking back, and Recently before the feed', () => {
    const screen = render(<TimelineScreen />);
    // This SafeAreaView lives inside the scrolling list. Applying the bottom
    // inset here creates a second Android navigation-bar-sized gap between
    // the Recently label and the first memory card.
    expect(screen.getByTestId('timeline-top-sections').props.edges).toEqual({
      bottom: 'off',
      left: 'off',
      right: 'off',
      top: 'additive',
    });
    const expectedSectionIds = new Set([
      'timeline-title-section',
      'timeline-week-section',
      'looking-back-rail',
      'timeline-recently-section',
    ]);
    const orderedSections = screen.getByTestId('timeline-top-sections')
      .findAll((node) => expectedSectionIds.has(node.props.testID))
      .map((node) => node.props.testID)
      .filter((testID, index, testIDs) => testIDs.indexOf(testID) === index);
    expect(orderedSections).toEqual([
      'timeline-title-section',
      'timeline-week-section',
      'looking-back-rail',
      'timeline-recently-section',
    ]);
    expect(screen.getByTestId('looking-back-rail')).toBeTruthy();
    expect(screen.getByText('Revisited today')).toBeTruthy();
  });

  it('starts a fresh package session before snapshotting and navigating', () => {
    const screen = render(<TimelineScreen />);
    fireEvent.press(screen.getByTestId('open-looking-back-package'));
    expect(mockClearCheckpoint).toHaveBeenCalledWith('package-1');
    expect(mockSavePackageSnapshot).toHaveBeenCalledWith(lookingBackPackage, null);
    expect(mockClearCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(mockSavePackageSnapshot.mock.invocationCallOrder[0]);
    expect(mockRouter.push).toHaveBeenCalledWith(expect.objectContaining({ params: { id: 'package-1' } }));
  });

  it('omits the rail completely when safety filtering or a family switch leaves no visible package', () => {
    mockUseLookingBackPackages.mockReturnValue({ packages: [], refetch: jest.fn() });
    const screen = render(<TimelineScreen />);
    expect(screen.queryByTestId('looking-back-rail')).toBeNull();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
