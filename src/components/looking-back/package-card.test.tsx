import { act, fireEvent, render } from '@testing-library/react-native';
import { withTiming } from 'react-native-reanimated';

import { LookingBackPackageCard, measureLookingBackCard } from './package-card';

const mockUseMediaUrls = jest.fn(() => ({ data: {} }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrls: (...args: unknown[]) => mockUseMediaUrls(...args) }));

const textMemory = {
  id: 'memory', memory_type: 'text_only', illustration_status: 'none', illustration_key: null,
  mediaAssets: [], emotion: 'wonder', updated_at: '2026-01-01', taggedMembers: [], content: 'Words',
} as any;

describe('LookingBackPackageCard', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); mockUseMediaUrls.mockReturnValue({ data: {} }); });
  afterEach(() => jest.useRealTimers());

  it('keeps the native view as the measureInWindow receiver', () => {
    const callback = jest.fn();
    const card = {
      measureInWindow(this: unknown, next: (...args: number[]) => void) {
        expect(this).toBe(card);
        next(1, 2, 168, 244);
      },
    };

    measureLookingBackCard(card, callback);

    expect(callback).toHaveBeenCalledWith(1, 2, 168, 244);
  });

  it('renders the approved text plate and opens exactly its package', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = render(<LookingBackPackageCard item={{ id: 'package', displayKind: 'From your archive', title: 'Small things, written down', era: '2024', memories: [textMemory], view: null, tint: 'wonder' }} onPress={onPress} />);
    expect(getByText('Small things, written down')).toBeTruthy();
    fireEvent.press(getByTestId('looking-back-package-package'));
    act(() => { jest.advanceTimersByTime(32); });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('uses quiet revisited copy instead of an unread treatment', () => {
    const { getByText } = render(<LookingBackPackageCard item={{ id: 'seen', displayKind: 'On this day', title: 'A year ago', era: '2025', memories: [textMemory], view: { firstViewedAt: '2026-08-08' }, tint: 'wonder' }} onPress={() => {}} />);
    expect(getByText('Revisited today')).toBeTruthy();
  });

  it('uses the approved 140ms press feedback rather than an immediate opacity jump', () => {
    const { getByTestId } = render(<LookingBackPackageCard item={{ id: 'package', displayKind: 'On this day', title: 'A small day', era: 'One year ago', memories: [] }} onPress={() => {}} />);
    fireEvent(getByTestId('looking-back-package-package'), 'pressIn');
    expect(withTiming).toHaveBeenCalledWith(1, { duration: 140 });
    fireEvent(getByTestId('looking-back-package-package'), 'pressOut');
    expect(withTiming).toHaveBeenCalledWith(0, { duration: 140 });
  });

  it('chooses a later photo over a first legacy video without a poster', () => {
    const videoThenPhoto = {
      ...textMemory, id: 'video-then-photo', memory_type: 'media', mediaAssets: [
        { id: 'raw-video', content_type: 'video/mp4', object_key: 'raw.mp4', preview_object_key: null, position: 0 },
        { id: 'photo', content_type: 'image/jpeg', object_key: 'usable.jpg', preview_object_key: null, position: 1 },
      ],
    };
    render(<LookingBackPackageCard item={{ id: 'mixed', displayKind: 'Archive', title: 'Mixed', era: '2024', memories: [videoThenPhoto] }} onPress={() => {}} />);
    expect(mockUseMediaUrls).toHaveBeenCalledWith(['usable.jpg'], expect.anything());
  });

  it('uses the text plate for a legacy raw video with no stored poster', () => {
    const rawVideoOnly = {
      ...textMemory, id: 'raw-video-only', memory_type: 'media', mediaAssets: [
        { id: 'raw-video', content_type: 'video/quicktime', object_key: 'raw.mov', preview_object_key: null, position: 0 },
      ],
    };
    render(<LookingBackPackageCard item={{ id: 'legacy', displayKind: 'Archive', title: 'Legacy', era: '2024', memories: [rawVideoOnly] }} onPress={() => {}} />);
    expect(mockUseMediaUrls).toHaveBeenCalledWith([], expect.anything());
  });
});
