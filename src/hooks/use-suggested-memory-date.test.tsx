import { act, render, renderHook } from '@testing-library/react-native';
import { useState } from 'react';
import { Text } from 'react-native';

import { todayIsoDate } from '@/utils/dates';

import { useSuggestedMemoryDate } from './use-suggested-memory-date';

interface Attachment {
  id: string;
  capturedAtIso?: string;
}

function dated(id: string, capturedAtIso?: string): Attachment {
  return { id, capturedAtIso };
}

describe('useSuggestedMemoryDate', () => {
  it('starts at the session baseline (today) with source "default"', () => {
    const { result } = renderHook(() => useSuggestedMemoryDate({ attachments: [] }));

    expect(result.current.memoryDate).toBe(todayIsoDate());
    expect(result.current.dateSource).toBe('default');
  });

  it('applies a dated attachment as source "media"', () => {
    const { result, rerender } = renderHook(
      ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
      { initialProps: { attachments: [] as Attachment[] } },
    );

    rerender({ attachments: [dated('a', '2024-06-01')] });

    expect(result.current.memoryDate).toBe('2024-06-01');
    expect(result.current.dateSource).toBe('media');
  });

  it('appending an attachment without EXIF alongside a dated one keeps the dated suggestion', () => {
    const { result, rerender } = renderHook(
      ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
      { initialProps: { attachments: [dated('a', '2024-06-01')] as Attachment[] } },
    );

    rerender({ attachments: [dated('a', '2024-06-01'), dated('b')] });

    expect(result.current.memoryDate).toBe('2024-06-01');
    expect(result.current.dateSource).toBe('media');
  });

  it('multiple batches of attachments choose the overall earliest date', () => {
    const { result, rerender } = renderHook(
      ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
      { initialProps: { attachments: [dated('a', '2024-06-10')] as Attachment[] } },
    );
    expect(result.current.memoryDate).toBe('2024-06-10');

    rerender({ attachments: [dated('a', '2024-06-10'), dated('b', '2024-06-03')] });
    expect(result.current.memoryDate).toBe('2024-06-03');

    rerender({
      attachments: [dated('a', '2024-06-10'), dated('b', '2024-06-03'), dated('c', '2024-06-01')],
    });
    expect(result.current.memoryDate).toBe('2024-06-01');
  });

  it('removing the earliest-dated attachment falls back to the next-earliest', () => {
    const { result, rerender } = renderHook(
      ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
      {
        initialProps: {
          attachments: [dated('a', '2024-06-01'), dated('b', '2024-06-05')] as Attachment[],
        },
      },
    );
    expect(result.current.memoryDate).toBe('2024-06-01');

    rerender({ attachments: [dated('b', '2024-06-05')] });

    expect(result.current.memoryDate).toBe('2024-06-05');
    expect(result.current.dateSource).toBe('media');
  });

  it('removing the last dated attachment restores the original session baseline, not a freshly computed today', () => {
    const baseline = todayIsoDate();
    const { result, rerender } = renderHook(
      ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
      { initialProps: { attachments: [dated('a', '2024-06-01')] as Attachment[] } },
    );
    expect(result.current.memoryDate).toBe('2024-06-01');

    rerender({ attachments: [] });

    expect(result.current.memoryDate).toBe(baseline);
    expect(result.current.dateSource).toBe('default');
  });

  it('a reorder that keeps the same earliest date does not change dateSource identity churn', () => {
    const { result, rerender } = renderHook(
      ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
      {
        initialProps: {
          attachments: [dated('a', '2024-06-01'), dated('b', '2024-06-05')] as Attachment[],
        },
      },
    );
    expect(result.current.memoryDate).toBe('2024-06-01');
    const setMemoryDateBefore = result.current.setMemoryDate;

    // Reordered: same two items, same earliest value, different array order/identity.
    rerender({ attachments: [dated('b', '2024-06-05'), dated('a', '2024-06-01')] });

    expect(result.current.memoryDate).toBe('2024-06-01');
    expect(result.current.dateSource).toBe('media');
    expect(result.current.setMemoryDate).toBe(setMemoryDateBefore);
  });

  describe('manual override', () => {
    it('setMemoryDate sets source to "user"', () => {
      const { result } = renderHook(() => useSuggestedMemoryDate({ attachments: [] }));

      act(() => {
        result.current.setMemoryDate('2024-01-15');
      });

      expect(result.current.memoryDate).toBe('2024-01-15');
      expect(result.current.dateSource).toBe('user');
    });

    it('atomically sets source to "user" even when the chosen value equals the current suggestion', () => {
      const { result } = renderHook(
        ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
        { initialProps: { attachments: [dated('a', '2024-06-01')] as Attachment[] } },
      );
      expect(result.current.memoryDate).toBe('2024-06-01');
      expect(result.current.dateSource).toBe('media');

      act(() => {
        result.current.setMemoryDate('2024-06-01');
      });

      expect(result.current.memoryDate).toBe('2024-06-01');
      expect(result.current.dateSource).toBe('user');
    });

    it('survives appending a new dated attachment after override', () => {
      const { result, rerender } = renderHook(
        ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
        { initialProps: { attachments: [] as Attachment[] } },
      );

      act(() => {
        result.current.setMemoryDate('2024-01-15');
      });

      rerender({ attachments: [dated('a', '2024-06-01')] });

      expect(result.current.memoryDate).toBe('2024-01-15');
      expect(result.current.dateSource).toBe('user');
    });

    it('survives removing all attachments after override', () => {
      const { result, rerender } = renderHook(
        ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
        { initialProps: { attachments: [dated('a', '2024-06-01')] as Attachment[] } },
      );

      act(() => {
        result.current.setMemoryDate('2024-01-15');
      });

      rerender({ attachments: [] });

      expect(result.current.memoryDate).toBe('2024-01-15');
      expect(result.current.dateSource).toBe('user');
    });

    it('survives reordering after override', () => {
      const { result, rerender } = renderHook(
        ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
        {
          initialProps: {
            attachments: [dated('a', '2024-06-01'), dated('b', '2024-06-05')] as Attachment[],
          },
        },
      );

      act(() => {
        result.current.setMemoryDate('2024-01-15');
      });

      rerender({ attachments: [dated('b', '2024-06-05'), dated('a', '2024-06-01')] });

      expect(result.current.memoryDate).toBe('2024-01-15');
      expect(result.current.dateSource).toBe('user');
    });

    it('survives a wholesale attachment-array replacement after override', () => {
      const { result, rerender } = renderHook(
        ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
        { initialProps: { attachments: [dated('a', '2024-06-01')] as Attachment[] } },
      );

      act(() => {
        result.current.setMemoryDate('2024-01-15');
      });

      rerender({ attachments: [dated('z', '2024-09-09'), dated('y', '2024-01-01')] });

      expect(result.current.memoryDate).toBe('2024-01-15');
      expect(result.current.dateSource).toBe('user');
    });
  });

  it('keeps the session baseline fixed if the system clock crosses midnight while mounted', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2024-06-15T23:59:00'));
      const { result, rerender } = renderHook(
        ({ attachments }: { attachments: Attachment[] }) => useSuggestedMemoryDate({ attachments }),
        { initialProps: { attachments: [] as Attachment[] } },
      );
      expect(result.current.memoryDate).toBe('2024-06-15');

      act(() => {
        jest.setSystemTime(new Date('2024-06-16T00:05:00'));
      });
      // No attachment change -- the hook itself does nothing on a bare
      // re-render, but confirm the baseline captured at mount is untouched
      // even after time has moved past midnight.
      rerender({ attachments: [] });

      expect(result.current.memoryDate).toBe('2024-06-15');
      expect(result.current.dateSource).toBe('default');
    } finally {
      jest.useRealTimers();
    }
  });

  it('memoryDate and dateSource are always internally consistent, including across an intermediate reconciliation render', () => {
    const observed: { memoryDate: string; dateSource: string }[] = [];

    function Probe({ attachments }: { attachments: Attachment[] }) {
      const { memoryDate, dateSource } = useSuggestedMemoryDate({ attachments });
      observed.push({ memoryDate, dateSource });
      return <Text>{memoryDate}</Text>;
    }

    function Harness() {
      const [attachments, setAttachments] = useState<Attachment[]>([]);
      return (
        <>
          <Probe attachments={attachments} />
          <Text
            testID="add"
            onPress={() => setAttachments([dated('a', '2024-06-01')])}
          >
            add
          </Text>
        </>
      );
    }

    const screen = render(<Harness />);

    act(() => {
      screen.getByTestId('add').props.onPress();
    });

    for (const snapshot of observed) {
      if (snapshot.dateSource === 'media') {
        expect(snapshot.memoryDate).not.toBe('');
      }
    }
    expect(observed[observed.length - 1]).toEqual({
      memoryDate: '2024-06-01',
      dateSource: 'media',
    });
  });
});
