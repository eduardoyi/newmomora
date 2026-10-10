import { fireEvent, render } from '@testing-library/react-native';

import { hasFloorTrace, SILENT_WAVEFORM } from '@/components/audio/trace-test-utils';
import { MemoryStamp } from '@/components/memory-stamp';
import type { MemoryWithTags } from '@/services/memories';

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: null })),
}));
jest.mock('@/hooks/useVideoThumbnail', () => ({
  useVideoThumbnail: jest.fn(() => null),
}));

function memory(overrides: Partial<MemoryWithTags>): MemoryWithTags {
  return {
    id: 'memory-1',
    memory_type: 'text_only',
    memory_date: '2026-09-01',
    emotion: 'joy',
    illustration_key: null,
    media_key: null,
    media_content_type: null,
    updated_at: '2026-09-01T00:00:00Z',
    mediaAssets: [],
    taggedMembers: [],
    ...overrides,
  } as unknown as MemoryWithTags;
}

// Shared by the Calendar ribbon and the Timeline month grid
// (docs/plans/timeline-calendar-keepsakes.md B2).
describe('MemoryStamp', () => {
  it('renders the audio stamp as a SoundTile at the requested size', () => {
    const { getByTestId } = render(
      <MemoryStamp
        isIllustrationHidden={false}
        memory={memory({ id: 'sound-1', memory_type: 'audio', mediaAssets: [{ duration_ms: 12000, content_type: 'audio/mp4' } as never] })}
        size={40}
        testIDPrefix="grid"
      />,
    );
    expect(getByTestId('grid-sound-1-sound')).toBeTruthy();
  });

  it('draws the real waveform in the audio stamp when the media row has one', () => {
    const stamp = (waveform: number[] | null) => (
      <MemoryStamp
        isIllustrationHidden={false}
        memory={memory({ id: 'sound-1', memory_type: 'audio', mediaAssets: [{ duration_ms: 12000, content_type: 'audio/mp4', waveform } as never] })}
        size={40}
        testIDPrefix="grid"
      />
    );
    const seeded = render(stamp(null));
    expect(hasFloorTrace(seeded.toJSON())).toBe(false);
    seeded.unmount();
    expect(hasFloorTrace(render(stamp(SILENT_WAVEFORM)).toJSON())).toBe(true);
  });

  it('renders the quote glyph for a text-only memory', () => {
    const { getByText } = render(<MemoryStamp isIllustrationHidden={false} memory={memory({})} />);
    expect(getByText('“')).toBeTruthy();
  });

  it('offers an inline Show button for a reported illustration on the ribbon', () => {
    const onShowIllustration = jest.fn();
    const { getByTestId } = render(
      <MemoryStamp
        isIllustrationHidden
        memory={memory({ id: 'ill-1', memory_type: 'text_illustration' })}
        onShowIllustration={onShowIllustration}
      />,
    );
    fireEvent.press(getByTestId('calendar-memory-ill-1-illustration-show'), { stopPropagation: jest.fn() });
    expect(onShowIllustration).toHaveBeenCalled();
  });

  it('renders a reported illustration as a plain, non-interactive tile in the grid', () => {
    const { getByTestId, queryByTestId } = render(
      <MemoryStamp
        isIllustrationHidden
        memory={memory({ id: 'ill-1', memory_type: 'text_illustration' })}
        testIDPrefix="grid"
      />,
    );
    expect(getByTestId('grid-ill-1-illustration-hidden')).toBeTruthy();
    expect(queryByTestId('grid-ill-1-illustration-show')).toBeNull();
  });
});
