// The trim sheet: a bottom sheet that lets the parent keep just part of a
// sound before saving ("keep the sound" recordings and imported voice notes).
// It always edits relative to the ORIGINAL source -- the composer re-renders
// from the original on Done, and Reset only moves the handles back to the
// full length (docs/plans/audio-trim-import.md "Composer state & flows").
//
// Visual language is the audio kit's, not an editor's: the real loudness of
// the whole sound is drawn as hand-inked bars (faint pencil outside the
// selection, graphite ink inside it), the kept part sits in a ticket-like
// frame, and the preview button is the same wax-style ListenSeal used on
// every sound surface.
//
// Gestures: ONE pan on the whole track picks the nearest handle on touch-down
// (within a 44 pt reach) and moves it. That gives both handles a >= 44 pt
// target without the two hit areas fighting each other when the selection is
// tiny. The handle views themselves are accessibility elements
// (`adjustable`, +/- 0.5 s) and carry no gesture of their own.
//
// A Modal is its own native window on Android, so it carries its own
// GestureHandlerRootView (same as memory-comments-drawer.tsx).
//
// Preview playback uses useAudioClipPlayback (create-once player + replace(),
// commit 25ef6be) with `playRange`: the pause at the end handle is driven by
// 250 ms status updates, so the preview can run up to ~250 ms past the end
// handle. Accepted for a preview; the saved file is cut exactly.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import { getBottomSheetBottomPadding } from '@/utils/bottom-sheet-dismiss';
import { waveformFromEnergies } from '@/utils/audio-waveform';

import { formatClipTime } from './audio-emotion';
import { ListenSeal } from './listen-seal';

export interface TrimSheetProps {
  visible: boolean;
  /** The original clip (always a playable file). */
  sourceUri: string;
  /** Decoded duration -- trust this, not any recorder value. */
  durationMs: number;
  /** Fine energy buckets of the whole source (from native analyze). */
  energies: number[];
  bucketMs: number;
  initialRange: { startMs: number; endMs: number };
  /** initialRange came from suggestTrim -> show the "quiet bits" hint. */
  suggested: boolean;
  /** 120_000 for recordings, 300_000 for imports. */
  maxSelectionMs: number;
  /** Import longer than 5:00: Cancel = abandon the import. */
  mustTrim: boolean;
  /** Show one quiet line: "Your note stays as you wrote it." */
  hasUserNote: boolean;
  onCancel: () => void;
  onDone: (range: { startMs: number; endMs: number }) => void;
  /** Fires after the Modal has fully dismissed -- used for modal hand-offs. */
  onDismissed?: () => void;
  testID?: string;
}

export type TrimRange = { startMs: number; endMs: number };
export type TrimHandle = 'start' | 'end';

export const MIN_TRIM_SELECTION_MS = 1000;
/** Step for the accessibility increment/decrement actions. */
export const TRIM_NUDGE_MS = 500;
/** How far from a handle a touch still grabs it (points). */
export const TRIM_HANDLE_REACH = 44;

const DISPLAY_BARS = 160;
const TRACK_HEIGHT = 96;
// Horizontal room inside the track so a handle at 0 or at the end still has
// its whole grab area on screen.
const TRACK_INSET = 24;
const KNOB = 22;
const MIN_BAR = 0.08;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Keeps a range inside [0, durationMs] and at least `minMs` long, moving only
 * the handle that was dragged (`moved`) -- the other handle never shifts, so
 * dragging clamps instead of pushing. Pure, so the "start < end - 1000"
 * invariant is unit-testable without simulating gestures.
 */
export function clampTrimRange(
  range: TrimRange,
  durationMs: number,
  moved: TrimHandle,
  minMs: number = MIN_TRIM_SELECTION_MS,
): TrimRange {
  const duration = Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0));
  const min = Math.min(minMs, duration);
  const start = clamp(Math.round(Number.isFinite(range.startMs) ? range.startMs : 0), 0, duration);
  const end = clamp(Math.round(Number.isFinite(range.endMs) ? range.endMs : duration), 0, duration);
  if (moved === 'start') {
    const safeEnd = clamp(end, min, duration);
    return { startMs: clamp(start, 0, safeEnd - min), endMs: safeEnd };
  }
  const safeStart = clamp(start, 0, duration - min);
  return { startMs: safeStart, endMs: clamp(end, safeStart + min, duration) };
}

/** Picks the handle a touch at `touchX` grabs, or null if neither is within reach. */
export function pickTrimHandle(
  touchX: number,
  startX: number,
  endX: number,
  reach: number = TRIM_HANDLE_REACH,
): TrimHandle | null {
  const startDistance = Math.abs(touchX - startX);
  const endDistance = Math.abs(touchX - endX);
  if (Math.min(startDistance, endDistance) > reach) {
    return null;
  }
  if (startDistance === endDistance) {
    // Equidistant: the side of the midpoint the finger is on decides; dead
    // centre of an (impossible) zero-width selection favours the start.
    return touchX <= startX ? 'start' : touchX >= endX ? 'end' : 'start';
  }
  return startDistance < endDistance ? 'start' : 'end';
}

/** "m:ss.t" -- rounded to 0.1 s, built on the kit's shared m:ss formatter. */
export function formatTrimTime(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const tenths = Math.round(safe / 100);
  return `${formatClipTime(Math.floor(tenths / 10))}.${tenths % 10}`;
}

function formatMaxLabel(maxSelectionMs: number): string {
  const seconds = Math.round(maxSelectionMs / 1000);
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} seconds`;
}

function barsPath(levels: number[], from: number, to: number, filter: (index: number) => boolean): string {
  let d = '';
  for (let i = from; i < to; i++) {
    if (!filter(i)) {
      continue;
    }
    const h = MIN_BAR + (1 - MIN_BAR) * (levels[i] / 255);
    const y1 = 50 - (h * 100) / 2;
    const y2 = 50 + (h * 100) / 2;
    d += `M${i + 0.5} ${y1.toFixed(2)}L${i + 0.5} ${y2.toFixed(2)}`;
  }
  return d;
}

export function TrimSheet({
  visible,
  sourceUri,
  durationMs,
  energies,
  initialRange,
  suggested,
  maxSelectionMs,
  mustTrim,
  hasUserNote,
  onCancel,
  onDone,
  onDismissed,
  testID = 'trim-sheet',
}: TrimSheetProps) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const playback = useAudioClipPlayback(sourceUri);
  const { playing, position, pause, playRange } = playback;

  const [range, setRangeState] = useState<TrimRange>(() =>
    clampTrimRange(initialRange, durationMs, 'end'),
  );
  const rangeRef = useRef(range);
  const [touched, setTouched] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const trackWidthRef = useRef(0);
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;
  const dragRef = useRef<{ handle: TrimHandle; originMs: number } | null>(null);
  const pauseRef = useRef(pause);
  pauseRef.current = pause;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const applyRange = useCallback((next: TrimRange) => {
    rangeRef.current = next;
    setRangeState(next);
  }, []);

  // Each open starts from the composer's range (suggested or full) with a
  // clean slate; a parent re-render passing an equal range must not reset
  // the user's drag, hence the value deps.
  useEffect(() => {
    if (!visible) {
      return;
    }
    applyRange(clampTrimRange(initialRange, durationMs, 'end'));
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialRange.startMs, initialRange.endMs, durationMs, applyRange]);

  // The sheet has no TextInput; don't fight the composer's keyboard state.
  useEffect(() => {
    if (visible) {
      Keyboard.dismiss();
    }
  }, [visible]);

  // Never keep playing behind a closed sheet.
  useEffect(() => {
    if (!visible) {
      pauseRef.current();
    }
  }, [visible]);

  // iOS fires Modal.onDismiss itself; Android has no such callback, so the
  // hand-off fires once the Modal has been told to close.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (wasVisibleRef.current && !visible && Platform.OS !== 'ios') {
      onDismissed?.();
    }
    wasVisibleRef.current = visible;
  }, [visible, onDismissed]);

  const levels = useMemo(
    () => waveformFromEnergies(energies, { buckets: DISPLAY_BARS }),
    [energies],
  );

  const selectionMs = range.endMs - range.startMs;
  const overMax = selectionMs > maxSelectionMs;
  const maxLabel = formatMaxLabel(maxSelectionMs);
  const innerWidth = Math.max(0, trackWidth - TRACK_INSET * 2);
  const duration = Math.max(1, durationMs);
  const startX = TRACK_INSET + (range.startMs / duration) * innerWidth;
  const endX = TRACK_INSET + (range.endMs / duration) * innerWidth;

  const insidePath = useMemo(
    () =>
      barsPath(levels, 0, DISPLAY_BARS, (i) => {
        const centre = ((i + 0.5) / DISPLAY_BARS) * duration;
        return centre >= range.startMs && centre <= range.endMs;
      }),
    [levels, duration, range.startMs, range.endMs],
  );
  const outsidePath = useMemo(
    () =>
      barsPath(levels, 0, DISPLAY_BARS, (i) => {
        const centre = ((i + 0.5) / DISPLAY_BARS) * duration;
        return centre < range.startMs || centre > range.endMs;
      }),
    [levels, duration, range.startMs, range.endMs],
  );

  const playheadFraction = playing && durationMs > 0 ? clamp((position * 1000) / durationMs, 0, 1) : null;

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    trackWidthRef.current = width;
    setTrackWidth(width);
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(2)
        .withTestId(`${testID}-pan`)
        .onBegin((event) => {
          const inner = Math.max(1, trackWidthRef.current - TRACK_INSET * 2);
          const current = rangeRef.current;
          const total = Math.max(1, durationRef.current);
          const sx = TRACK_INSET + (current.startMs / total) * inner;
          const ex = TRACK_INSET + (current.endMs / total) * inner;
          const handle = pickTrimHandle(event.x, sx, ex);
          dragRef.current = handle
            ? { handle, originMs: handle === 'start' ? current.startMs : current.endMs }
            : null;
        })
        .onUpdate((event) => {
          const drag = dragRef.current;
          if (!drag) {
            return;
          }
          if (playingRef.current) {
            pauseRef.current();
          }
          const inner = Math.max(1, trackWidthRef.current - TRACK_INSET * 2);
          const deltaMs = (event.translationX / inner) * durationRef.current;
          const moving = drag.originMs + deltaMs;
          const current = rangeRef.current;
          const next = clampTrimRange(
            drag.handle === 'start'
              ? { startMs: moving, endMs: current.endMs }
              : { startMs: current.startMs, endMs: moving },
            durationRef.current,
            drag.handle,
          );
          if (next.startMs !== current.startMs || next.endMs !== current.endMs) {
            setTouched(true);
            applyRange(next);
          }
        })
        .onFinalize(() => {
          dragRef.current = null;
        }),
    [applyRange, testID],
  );

  const nudge = useCallback(
    (handle: TrimHandle, direction: 1 | -1) => (event: AccessibilityActionEvent) => {
      const name = event.nativeEvent.actionName;
      if (name !== 'increment' && name !== 'decrement') {
        return;
      }
      const delta = (name === 'increment' ? 1 : -1) * direction * TRIM_NUDGE_MS;
      const current = rangeRef.current;
      if (playingRef.current) {
        pauseRef.current();
      }
      setTouched(true);
      applyRange(
        clampTrimRange(
          handle === 'start'
            ? { startMs: current.startMs + delta, endMs: current.endMs }
            : { startMs: current.startMs, endMs: current.endMs + delta },
          durationRef.current,
          handle,
        ),
      );
    },
    [applyRange],
  );

  const handleReset = useCallback(() => {
    pause();
    setTouched(true);
    applyRange({ startMs: 0, endMs: Math.max(0, Math.round(durationRef.current)) });
  }, [applyRange, pause]);

  const handleCancel = useCallback(() => {
    pause();
    onCancel();
  }, [onCancel, pause]);

  const handleDone = useCallback(() => {
    if (overMax) {
      return;
    }
    pause();
    onDone({ startMs: rangeRef.current.startMs, endMs: rangeRef.current.endMs });
  }, [onDone, overMax, pause]);

  const handlePlay = useCallback(() => {
    if (playing) {
      pause();
      return;
    }
    void playRange(rangeRef.current.startMs / 1000, rangeRef.current.endMs / 1000);
  }, [pause, playRange, playing]);

  const title = mustTrim ? `Choose up to ${maxLabel} to keep` : 'Trim this sound';
  const subtitle = suggested && !touched ? 'We trimmed the quiet bits. Drag to adjust.' : null;

  return (
    <Modal
      animationType={reducedMotion ? 'fade' : 'slide'}
      onDismiss={onDismissed}
      onRequestClose={handleCancel}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      {/* A Modal is a separate Android native window, so it needs its own
          gesture root rather than relying on the app-level root. */}
      <GestureHandlerRootView style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          // A must-trim import is abandoned by Cancel; a stray backdrop tap
          // shouldn't be able to do that.
          disabled={mustTrim}
          onPress={handleCancel}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) },
          ]}
          testID={testID}
        >
          <View style={styles.grabber} />

          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title} testID={`${testID}-title`}>
              {title}
            </Text>
            <Text style={styles.subtitle} testID={`${testID}-hint`}>
              {subtitle ?? 'Drag the ends to keep just the part you want.'}
            </Text>
          </View>

          <GestureDetector gesture={pan}>
            <View
              collapsable={false}
              onLayout={handleTrackLayout}
              style={styles.track}
              testID={`${testID}-track`}
            >
              <Svg
                height={TRACK_HEIGHT}
                preserveAspectRatio="none"
                style={styles.waveform}
                viewBox={`0 0 ${DISPLAY_BARS} 100`}
                width={innerWidth}
              >
                <Path
                  d={outsidePath}
                  fill="none"
                  stroke={colors.ink2}
                  strokeOpacity={0.22}
                  strokeWidth={0.6}
                />
                <Path d={insidePath} fill="none" stroke={colors.ink2} strokeWidth={0.6} />
              </Svg>

              {trackWidth > 0 ? (
                <>
                  {/* The kept part, framed like a ticket stub. */}
                  <View
                    pointerEvents="none"
                    style={[styles.selection, { left: startX, width: Math.max(0, endX - startX) }]}
                    testID={`${testID}-selection`}
                  />

                  {playheadFraction !== null ? (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.playhead,
                        { left: TRACK_INSET + playheadFraction * innerWidth - 1 },
                      ]}
                      testID={`${testID}-playhead`}
                    />
                  ) : null}

                  <View
                    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                    accessibilityLabel="Start of the sound you keep"
                    accessibilityRole="adjustable"
                    accessibilityValue={{ text: formatTrimTime(range.startMs) }}
                    accessible
                    onAccessibilityAction={nudge('start', 1)}
                    pointerEvents="none"
                    style={[styles.handle, { left: startX - KNOB / 2 }]}
                    testID={`${testID}-start-handle`}
                  >
                    <View style={styles.handleStem} />
                    <View style={styles.knob}>
                      <View style={styles.knobGroove} />
                      <View style={styles.knobGroove} />
                    </View>
                  </View>

                  <View
                    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                    accessibilityLabel="End of the sound you keep"
                    accessibilityRole="adjustable"
                    accessibilityValue={{ text: formatTrimTime(range.endMs) }}
                    accessible
                    onAccessibilityAction={nudge('end', 1)}
                    pointerEvents="none"
                    style={[styles.handle, { left: endX - KNOB / 2 }]}
                    testID={`${testID}-end-handle`}
                  >
                    <View style={styles.handleStem} />
                    <View style={styles.knob}>
                      <View style={styles.knobGroove} />
                      <View style={styles.knobGroove} />
                    </View>
                  </View>
                </>
              ) : null}
            </View>
          </GestureDetector>

          <View style={styles.labels}>
            <View style={styles.labelColumn}>
              <Text style={styles.labelCaption}>Starts</Text>
              <Text style={styles.labelTime} testID={`${testID}-start-time`}>
                {formatTrimTime(range.startMs)}
              </Text>
            </View>
            <View style={[styles.labelColumn, styles.labelCenter]}>
              <Text style={styles.labelCaption}>Keeping</Text>
              <Text
                style={[styles.labelTime, styles.labelLength, overMax && styles.labelOver]}
                testID={`${testID}-length`}
              >
                {formatTrimTime(selectionMs)}
              </Text>
            </View>
            <View style={[styles.labelColumn, styles.labelRight]}>
              <Text style={styles.labelCaption}>Ends</Text>
              <Text style={styles.labelTime} testID={`${testID}-end-time`}>
                {formatTrimTime(range.endMs)}
              </Text>
            </View>
          </View>

          {overMax ? (
            <Text accessibilityLiveRegion="polite" style={styles.overMax} testID={`${testID}-over-max`}>
              {`Keep up to ${maxLabel}`}
            </Text>
          ) : null}

          <View style={styles.controls}>
            <View style={styles.playRow}>
              <ListenSeal
                accessibilityLabel={playing ? 'Pause' : 'Play the part you keep'}
                emotion={null}
                onPress={handlePlay}
                playing={playing}
                size={44}
                testID={`${testID}-play`}
              />
              <Text style={styles.playCaption}>Hear what you keep</Text>
            </View>
            <Pressable
              accessibilityLabel="Reset to the whole sound"
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleReset}
              style={styles.resetButton}
              testID={`${testID}-reset`}
            >
              <Text style={styles.resetText}>Reset</Text>
            </Pressable>
          </View>

          {hasUserNote ? (
            <Text style={styles.note} testID={`${testID}-note`}>
              Your note stays as you wrote it.
            </Text>
          ) : null}

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              onPress={handleCancel}
              style={[styles.button, styles.cancelButton]}
              testID={`${testID}-cancel`}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: overMax }}
              disabled={overMax}
              onPress={handleDone}
              style={[styles.button, styles.doneButton, overMax && styles.doneDisabled]}
              testID={`${testID}-done`}
            >
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44,36,24,0.34)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
    paddingHorizontal: spacing.md,
  },
  grabber: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: radius.pill,
    height: 5,
    marginTop: 10,
    width: 40,
  },
  header: { gap: 4, paddingBottom: spacing.md, paddingHorizontal: 4, paddingTop: spacing.md },
  title: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 20 },
  subtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 19 },
  track: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    height: TRACK_HEIGHT + 24,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  waveform: { alignSelf: 'center' },
  selection: {
    backgroundColor: 'rgba(107,94,79,0.09)',
    borderColor: colors.ink2,
    borderBottomWidth: 1.5,
    borderTopWidth: 1.5,
    bottom: 6,
    position: 'absolute',
    top: 6,
  },
  playhead: {
    backgroundColor: colors.ink,
    bottom: 10,
    opacity: 0.75,
    position: 'absolute',
    top: 10,
    width: 2,
  },
  handle: {
    alignItems: 'center',
    bottom: 0,
    position: 'absolute',
    top: 0,
    width: KNOB,
  },
  handleStem: {
    backgroundColor: colors.ink2,
    borderRadius: 1.5,
    bottom: 6,
    position: 'absolute',
    top: 6,
    width: 3,
  },
  knob: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.ink2,
    borderRadius: KNOB / 2,
    borderWidth: 1.5,
    elevation: 2,
    flexDirection: 'row',
    gap: 2,
    height: KNOB,
    justifyContent: 'center',
    marginTop: (TRACK_HEIGHT + 24 - KNOB) / 2 - 1,
    shadowColor: 'rgba(44,36,24,1)',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 2,
    width: KNOB,
  },
  knobGroove: { backgroundColor: colors.ink3, borderRadius: 1, height: 9, width: 1.5 },
  labels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingTop: spacing.sm + 4,
  },
  labelColumn: { flex: 1, gap: 1 },
  labelCenter: { alignItems: 'center' },
  labelRight: { alignItems: 'flex-end' },
  labelCaption: {
    color: colors.ink3,
    fontFamily: fonts.sansMedium,
    fontSize: 11.5,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  labelTime: { color: colors.ink2, fontFamily: fonts.sansMedium, fontSize: 14.5, letterSpacing: -0.2 },
  labelLength: { color: colors.ink, fontFamily: fonts.sansBold },
  labelOver: { color: colors.error },
  overMax: {
    color: colors.error,
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    paddingHorizontal: 4,
    paddingTop: spacing.sm,
    textAlign: 'center',
  },
  controls: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingTop: spacing.md,
  },
  playRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm + 4 },
  playCaption: { color: colors.ink2, fontFamily: fonts.sansMedium, fontSize: 13.5 },
  resetButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: spacing.md,
  },
  resetText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 13.5 },
  note: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 12.5,
    paddingHorizontal: 4,
    paddingTop: spacing.md,
  },
  footer: { flexDirection: 'row', gap: spacing.sm + 4, paddingTop: spacing.md },
  button: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flex: 1,
    justifyContent: 'center',
    minHeight: 50,
  },
  cancelButton: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  cancelText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 15 },
  doneButton: { backgroundColor: colors.primary },
  doneDisabled: { opacity: 0.4 },
  doneText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 },
});
