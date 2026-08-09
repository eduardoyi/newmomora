import { render } from '@testing-library/react-native';
import { StoryProgress } from './story-progress';

describe('StoryProgress', () => {
  it('uses equal-width frame ticks regardless of dwell duration', () => {
    const chapters = [
      { memory: { id: 'memory-1' }, totalDurationMs: 4000, frames: [{ id: 'a', index: 0, chapterIndex: 0, durationMs: 1500 }, { id: 'b', index: 1, chapterIndex: 0, durationMs: 2500 }] },
      { memory: { id: 'memory-2' }, totalDurationMs: 3000, frames: [{ id: 'c', index: 2, chapterIndex: 1, durationMs: 3000 }] },
    ] as any;
    const { getByLabelText, getByTestId } = render(<StoryProgress chapters={chapters} frame={chapters[0].frames[1]} frameFraction={0.5} progress={{ value: 0.5 } as any} />);

    expect(getByLabelText('Memory 1 of 2')).toBeTruthy();
    const first = getByTestId('looking-back-progress-frame-0').props.style;
    const second = getByTestId('looking-back-progress-frame-1').props.style;
    const third = getByTestId('looking-back-progress-frame-2').props.style;
    expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ flex: 1 }), { marginLeft: 0 }]));
    expect(second).toEqual(expect.arrayContaining([expect.objectContaining({ flex: 1 }), { marginLeft: 2 }]));
    expect(third).toEqual(expect.arrayContaining([expect.objectContaining({ flex: 1 }), { marginLeft: 5 }]));
  });
});
