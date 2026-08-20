import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';

import { ClipChip } from '@/components/audio/clip-chip';
import { SoundMark } from '@/components/audio/sound-tile';
import { colors, fonts } from '@/constants/theme';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import {
  MAX_RECORDING_MS,
  useVoiceInput,
  type VoiceProcessingResult,
  type VoiceTranscriptionStatus,
} from '@/hooks/useVoiceInput';
import { useFamily } from '@/hooks/use-family';
import { trackEvent } from '@/services/analytics';
import type { VoiceFamilyMemberPayload } from '@/services/ai';
import { claimAudioClip } from '@/utils/audio-clip-custody';

// Teal accent used only on this screen — matches the design mock
const TEAL = '#6AAEAA';
const MIC_SIZE = 88;
const RING_SIZE = MIC_SIZE * 1.7; // base size of each ring
// The last stretch of a recording where the 2:00 auto-stop cap gets a quiet
// heads-up pill instead of arriving as a surprise (docs/plans/
// audio-memories-v1.md P2.2 "2:00 auto-stop treatment").
const CAP_WARNING_MS = 15 * 1000;

/** The clip handed to the composer once the user chooses "Keep the sound". */
export interface VoiceKeptClip {
  /** App-owned URI (already copied via claimAudioClip) -- not the recorder's temp file. */
  localUri: string;
  durationMs: number;
  transcriptionStatus: VoiceTranscriptionStatus;
  transcriptionResult: VoiceProcessingResult | null;
  /**
   * Non-null only when transcriptionStatus was still 'transcribing' at
   * keep-time. Resolves with the eventual outcome (or null on failure) --
   * safe to await after this modal has closed, since it's a plain promise
   * from useVoiceInput, not tied to that hook's component lifecycle. The
   * composer awaits this to fire the post-save description backfill
   * (docs/plans/audio-memories-v1.md P2.3).
   */
  pendingTranscription: Promise<VoiceProcessingResult | null> | null;
}

/**
 * `dictate` -- today's transcribe-only flow, unchanged. Default, so the edit
 * screen's dictation-into-existing-memory usage
 * (app/(app)/memory/[id]/edit.tsx) needs zero changes -- an audio memory's
 * type can never change once saved, so offering "Keep the sound" there
 * would be a lie.
 * `fork` -- the composer's first recording (docs/plans/audio-memories-v1.md
 * P2.2): stop lands on the two-button choice.
 * `keepOnly` -- the composer's re-record, once it's already an audio memory
 * (P2.3 "Recording again replaces this sound."): no fork, no dictate
 * option -- stop claims the clip and replaces the attached one directly.
 * Offering "Turn into text" here would silently keep the old clip while the
 * toolbar hint promises a replace, which is exactly the bug this mode
 * exists to avoid.
 */
export type VoiceCaptureMode = 'dictate' | 'fork' | 'keepOnly';

interface VoiceSpeakItModalProps {
  visible: boolean;
  familyMembers: VoiceFamilyMemberPayload[];
  /** See VoiceCaptureMode. Defaults to 'dictate'. */
  captureMode?: VoiceCaptureMode;
  onDismiss: () => void;
  onResult: (result: VoiceProcessingResult) => void;
  /** Required in practice when captureMode is 'fork' or 'keepOnly'. Called once, right before the modal closes. */
  onKeepSound?: (clip: VoiceKeptClip) => void;
}

interface VoiceSpeakItContentProps extends Omit<VoiceSpeakItModalProps, 'visible'> {
  canStartRecording: boolean;
}

/** A tiny deterministic hash -- only used to pick a stable SoundTrace seed for an unsaved clip's local URI. */
function seedFromUri(uri: string): number {
  let hash = 0;
  for (let i = 0; i < uri.length; i += 1) {
    hash = (hash * 31 + uri.charCodeAt(i)) % 233280;
  }
  return Math.abs(hash) || 1;
}

// Inner content is a separate component so the hook only mounts when visible=true
function VoiceSpeakItContent({
  familyMembers,
  canStartRecording,
  captureMode = 'dictate',
  onDismiss,
  onResult,
  onKeepSound,
}: VoiceSpeakItContentProps) {
  const { familyId } = useFamily();
  const {
    isRecording,
    durationMillis,
    durationLabel,
    errorMessage,
    stoppedClip,
    autoStopped,
    transcriptionStatus,
    transcriptionResult,
    transcriptionPromise,
    startRecording,
    stopRecording,
    discardStoppedClip,
    recordAgain,
  } = useVoiceInput(familyMembers, familyId);

  // Wait for the native modal presentation to finish before asking the OS to
  // present its microphone permission dialog.
  useEffect(() => {
    if (!canStartRecording) {
      return;
    }

    void startRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStartRecording]);

  // ── Post-recording fork state (composer only -- captureMode 'fork') ──
  const [textChosen, setTextChosen] = useState(false);
  const [isKeeping, setIsKeeping] = useState(false);
  const hasTrackedForkShownRef = useRef(false);

  useEffect(() => {
    if (!stoppedClip) {
      setTextChosen(false);
      setIsKeeping(false);
      hasTrackedForkShownRef.current = false;
    }
  }, [stoppedClip]);

  const forkVisible = captureMode === 'fork' && Boolean(stoppedClip);
  const isFailed = forkVisible && transcriptionStatus === 'failed';
  const isWaitingForText = forkVisible && textChosen && transcriptionStatus === 'transcribing' && !isFailed;
  // The legacy, fork-less dictation path (captureMode 'dictate' -- the edit
  // screen's usage): a stopped clip always means "turn into text", exactly
  // today's shipped flow.
  const legacyProcessing = Boolean(stoppedClip) && captureMode === 'dictate';
  // Re-record while already an audio memory (P2.3): no fork, no dictate
  // option -- stop claims the clip and replaces the attached one directly
  // (see the handleKeepSound auto-trigger effect below).
  const keepOnlyProcessing = Boolean(stoppedClip) && captureMode === 'keepOnly';

  useEffect(() => {
    if (!forkVisible || hasTrackedForkShownRef.current) {
      return;
    }
    hasTrackedForkShownRef.current = true;
    trackEvent('voice_fork_shown', { auto_stopped: autoStopped });
  }, [forkVisible, autoStopped]);

  // Applies the transcript once it's ready, on whichever path committed to
  // text: the legacy fork-less screen (always, once stopped), or the fork
  // once the user tapped "Turn into text". Neither branch should ever show
  // a spinner after the choice if the result is already in hand.
  useEffect(() => {
    const committedToText = legacyProcessing || (forkVisible && textChosen);
    if (!committedToText || !stoppedClip || transcriptionStatus !== 'done' || !transcriptionResult) {
      return;
    }
    const result = transcriptionResult;
    void discardStoppedClip();
    onResult(result);
    onDismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyProcessing, forkVisible, textChosen, stoppedClip, transcriptionStatus, transcriptionResult]);

  // Two ring animation values — ring2 lags ring1 by half a cycle for the ripple look
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isRecording) {
      ring1.setValue(0);
      ring2.setValue(0);
      return;
    }

    const DURATION = 1500;
    const PHASE_OFFSET_MS = 650;

    const makeLoop = (val: Animated.Value) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, {
            toValue: 1,
            duration: DURATION,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          // Instant reset so next iteration starts fresh
          Animated.timing(val, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      );

    const loop1 = makeLoop(ring1);
    loop1.start();

    // Ring 2 starts after a phase offset to create the ripple effect
    const timer = setTimeout(() => makeLoop(ring2).start(), PHASE_OFFSET_MS);

    return () => {
      loop1.stop();
      ring2.stopAnimation();
      clearTimeout(timer);
    };
  }, [isRecording, ring1, ring2]);

  const clipPlayback = useAudioClipPlayback(forkVisible ? stoppedClip?.localUri ?? null : null);

  const handleStopTap = () => {
    if (!isRecording) return;
    void stopRecording();
  };

  const handleCancel = async () => {
    if (stoppedClip) {
      await discardStoppedClip();
    }
    onDismiss();
  };

  const handleChooseText = () => {
    if (!forkVisible || isFailed || textChosen) {
      return;
    }
    trackEvent('voice_fork_choice', { choice: 'turn_into_text' });
    setTextChosen(true);
    // If the result is already in hand, the effect above fires on this
    // same render pass -- no extra spinner between the tap and the switch.
  };

  const handleKeepSound = async () => {
    if (!stoppedClip || isKeeping) {
      return;
    }
    // Only a real two-button fork choice counts as `voice_fork_choice` --
    // keepOnly's auto-trigger (re-record) never showed a fork, so there was
    // no choice to report.
    if (forkVisible) {
      trackEvent('voice_fork_choice', { choice: 'keep_the_sound' });
    }
    setIsKeeping(true);
    try {
      const claimedUri = await claimAudioClip(stoppedClip.localUri);
      onKeepSound?.({
        localUri: claimedUri,
        durationMs: stoppedClip.durationMs,
        transcriptionStatus,
        transcriptionResult,
        pendingTranscription: transcriptionStatus === 'transcribing' ? transcriptionPromise : null,
      });
    } finally {
      onDismiss();
    }
  };

  // keepOnly (re-record while already an audio memory): no fork, no user
  // choice -- the instant the clip stops, it claims and replaces the
  // attached one directly, matching the toolbar's "Recording again replaces
  // this sound." hint. Keeping never depends on the server, so this never
  // waits on transcription either.
  useEffect(() => {
    if (!keepOnlyProcessing || isKeeping) {
      return;
    }
    void handleKeepSound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepOnlyProcessing]);

  const handleRecordAgain = async () => {
    setTextChosen(false);
    await recordAgain();
  };

  const leftCapSeconds = Math.max(0, Math.ceil((MAX_RECORDING_MS - durationMillis) / 1000));
  const nearCap = isRecording && MAX_RECORDING_MS - durationMillis <= CAP_WARNING_MS;

  // Interpolated ring transforms
  const ring1Scale = ring1.interpolate({ inputRange: [0, 1], outputRange: [1, 1.85] });
  const ring1Opacity = ring1.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });
  const ring2Scale = ring2.interpolate({ inputRange: [0, 1], outputRange: [1, 1.85] });
  const ring2Opacity = ring2.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0] });

  const prompt = legacyProcessing
    ? 'Transcribing…'
    : keepOnlyProcessing
      ? 'Keeping the sound…'
      : forkVisible
        ? 'Keep it how?'
        : 'Tell me what happened.';

  const instruction = legacyProcessing || keepOnlyProcessing
    ? ''
    : forkVisible
      ? autoStopped
        ? 'Two minutes — that’s the longest a sound can be. Nothing is saved yet.'
        : 'Nothing is saved yet.'
      : isRecording
        ? durationLabel
        : 'Tap to stop. Max 2 minutes.';

  const displayError = errorMessage || (legacyProcessing && transcriptionStatus === 'failed' ? 'Voice processing failed' : '');

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable
          onPress={() => { void handleCancel(); }}
          style={styles.cancelBtn}
          accessibilityRole="button"
          accessibilityLabel="Cancel voice recording"
          testID="voice-speak-it-cancel"
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>

        <Text style={styles.title}>SPEAK IT</Text>

        {/* Spacer to keep title centred */}
        <View style={styles.headerSpacer} />
      </View>

      {/* ── Main content ── */}
      <View style={[styles.content, forkVisible && styles.contentForked]}>
        {/* Animated mic button + rings, or (once forked) a preview of the clip */}
        <View style={[styles.micArea, forkVisible && styles.micAreaForked]}>
          {isRecording && [0, 650].map((delay) => (
            <Animated.View
              key={delay}
              style={[
                styles.ring,
                {
                  transform: [{ scale: delay === 0 ? ring1Scale : ring2Scale }],
                  opacity: delay === 0 ? ring1Opacity : ring2Opacity,
                },
              ]}
            />
          ))}
          {forkVisible ? (
            <Pressable
              accessibilityLabel={clipPlayback.playing ? 'Pause' : 'Listen back'}
              accessibilityRole="button"
              onPress={() => { void clipPlayback.toggle(); }}
              style={styles.micBtn}
              testID="voice-speak-it-preview-toggle"
            >
              <SymbolView
                name={{ ios: clipPlayback.playing ? 'pause.fill' : 'play.fill', android: clipPlayback.playing ? 'pause' : 'play_arrow' }}
                size={30}
                tintColor="white"
                fallback={<Text style={styles.micFallback}>{clipPlayback.playing ? '⏸' : '▶'}</Text>}
              />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop recording"
              disabled={!isRecording}
              onPress={handleStopTap}
              style={[styles.micBtn, (legacyProcessing || keepOnlyProcessing) && styles.micBtnProcessing]}
              testID="voice-speak-it-mic"
            >
              {legacyProcessing || keepOnlyProcessing ? (
                <ActivityIndicator color="white" size="large" />
              ) : (
                <SymbolView
                  name={{ ios: 'mic.fill', android: 'mic' }}
                  size={36}
                  tintColor="white"
                  fallback={<Text style={styles.micFallback}>♪</Text>}
                />
              )}
            </Pressable>
          )}
        </View>

        {forkVisible && stoppedClip ? (
          <View style={styles.clipChipWrap}>
            <ClipChip
              durationSeconds={stoppedClip.durationMs / 1000}
              emotion={null}
              onToggle={() => { void clipPlayback.toggle(); }}
              playing={clipPlayback.playing}
              positionSeconds={clipPlayback.position}
              progress={clipPlayback.progress}
              seed={seedFromUri(stoppedClip.localUri)}
              slim
              testID="voice-speak-it-clip-chip"
            />
          </View>
        ) : null}

        {/* Prompt — 26px display, exactly as shipped */}
        <Text style={styles.prompt}>{prompt}</Text>

        {/* Instruction — 14px sans ink3; the duration label while recording */}
        <Text style={styles.instruction}>{instruction}</Text>

        {/* the 2:00 cap — a quiet heads-up in the last 15 seconds, never a warning */}
        {nearCap ? (
          <View style={styles.capPill} testID="voice-speak-it-cap-pill">
            <Text style={styles.capPillText}>{leftCapSeconds}s left — it stops on its own</Text>
          </View>
        ) : null}

        {displayError ? (
          <Text style={styles.errorText}>{displayError}</Text>
        ) : null}
      </View>

      {/* the fork — two choices of equal weight, one tap each */}
      {forkVisible ? (
        <View style={styles.forkWrap} testID="voice-speak-it-fork">
          <View style={styles.forkRow}>
            <ForkChoice
              busy={isWaitingForText}
              dim={isFailed}
              glyph={
                <SymbolView
                  fallback={<Text style={styles.forkGlyphFallback}>Aa</Text>}
                  name={{ ios: 'textformat', android: 'text_fields' }}
                  size={20}
                  tintColor={colors.ink3}
                />
              }
              label="Turn into text"
              onPress={handleChooseText}
              sub={
                isWaitingForText
                  ? 'still catching your words'
                  : isFailed
                    ? 'couldn’t catch the words'
                    : 'the recording goes away'
              }
              testID="voice-speak-it-choose-text"
            />
            <ForkChoice
              busy={isKeeping}
              emphasis={isFailed}
              glyph={<SoundMark emotion="calm" seed={7} size={30} stroke={1.9} />}
              label="Keep the sound"
              onPress={() => { void handleKeepSound(); }}
              sub="kept as it is"
              testID="voice-speak-it-keep-sound"
              tint={colors.seaSoft}
            />
          </View>
          {isFailed ? (
            <Text style={styles.forkFailedNote}>
              No connection, so the words will have to wait. The sound itself is right here — you can still keep it.
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => { void handleRecordAgain(); }}
            style={styles.recordAgainBtn}
            testID="voice-speak-it-record-again"
          >
            <Text style={styles.recordAgainText}>Record again</Text>
          </Pressable>
        </View>
      ) : null}

    </SafeAreaView>
  );
}

function ForkChoice({
  label,
  sub,
  glyph,
  tint,
  busy = false,
  dim = false,
  emphasis = false,
  onPress,
  testID,
}: {
  label: string;
  sub: string;
  glyph: ReactNode;
  tint?: string;
  busy?: boolean;
  dim?: boolean;
  emphasis?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: dim }}
      disabled={dim}
      onPress={onPress}
      style={[
        styles.forkChoice,
        dim && styles.forkChoiceDim,
        emphasis && styles.forkChoiceEmphasis,
      ]}
      testID={testID}
    >
      <View style={[styles.forkGlyphWrap, tint ? { backgroundColor: tint } : null]}>
        {busy ? <ActivityIndicator color={colors.ink3} size="small" /> : glyph}
      </View>
      <Text style={[styles.forkChoiceLabel, dim && styles.forkChoiceLabelDim]}>{label}</Text>
      <Text style={styles.forkChoiceSub}>{sub}</Text>
    </Pressable>
  );
}

function PresentedVoiceSpeakItModal({
  familyMembers,
  captureMode,
  onDismiss,
  onResult,
  onKeepSound,
}: Omit<VoiceSpeakItModalProps, 'visible'>) {
  const [isPresented, setIsPresented] = useState(false);

  return (
    <Modal
      animationType="slide"
      onShow={() => setIsPresented(true)}
      onRequestClose={onDismiss}
      statusBarTranslucent={false}
      testID="voice-speak-it-modal"
      visible
    >
      <VoiceSpeakItContent
        captureMode={captureMode}
        canStartRecording={isPresented}
        familyMembers={familyMembers}
        onDismiss={onDismiss}
        onKeepSound={onKeepSound}
        onResult={onResult}
      />
    </Modal>
  );
}

export function VoiceSpeakItModal({
  visible,
  familyMembers,
  captureMode,
  onDismiss,
  onResult,
  onKeepSound,
}: VoiceSpeakItModalProps) {
  if (!visible) {
    return null;
  }

  return (
    <PresentedVoiceSpeakItModal
      captureMode={captureMode}
      familyMembers={familyMembers}
      onDismiss={onDismiss}
      onKeepSound={onKeepSound}
      onResult={onResult}
    />
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 4,
  },
  cancelBtn: {
    padding: 4,
    minWidth: 64,
  },
  cancelText: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.primary,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.2,
    color: colors.ink2,
  },
  headerSpacer: {
    minWidth: 64,
  },
  // ── Main content ──
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 60,
  },
  contentForked: {
    paddingBottom: 0,
  },
  micArea: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 40,
  },
  micAreaForked: {
    height: MIC_SIZE,
    marginBottom: 20,
  },
  ring: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    backgroundColor: TEAL,
  },
  micBtn: {
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2,
    backgroundColor: TEAL,
    alignItems: 'center',
    justifyContent: 'center',
    // Subtle shadow so the button lifts off the rings
    shadowColor: TEAL,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  micBtnProcessing: {
    backgroundColor: colors.ink3,
    shadowColor: colors.ink3,
  },
  micFallback: {
    fontSize: 36,
    color: 'white',
  },
  clipChipWrap: {
    width: '100%',
    paddingHorizontal: 32,
    marginBottom: 20,
  },
  prompt: {
    fontFamily: fonts.display,
    fontSize: 26,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 10,
    paddingHorizontal: 32,
  },
  instruction: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.ink3,
    textAlign: 'center',
    letterSpacing: 0.1,
    paddingHorizontal: 32,
    lineHeight: 20,
  },
  capPill: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.seaSoft,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  capPillText: {
    fontFamily: fonts.sansBold,
    fontSize: 12.5,
    color: colors.seaInk,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
    textAlign: 'center',
    marginTop: 16,
    paddingHorizontal: 32,
  },
  forkWrap: {
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  forkRow: {
    flexDirection: 'row',
    gap: 10,
  },
  forkChoice: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 15,
    paddingHorizontal: 12,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    alignItems: 'center',
    gap: 10,
  },
  forkChoiceDim: {
    backgroundColor: colors.surface,
    opacity: 0.7,
  },
  forkChoiceEmphasis: {
    borderColor: colors.sea,
    shadowColor: colors.sea,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  forkGlyphWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forkGlyphFallback: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.ink3,
  },
  forkChoiceLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.ink,
    textAlign: 'center',
  },
  forkChoiceLabelDim: {
    color: colors.ink3,
  },
  forkChoiceSub: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'center',
  },
  forkFailedNote: {
    fontFamily: fonts.sans,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.ink2,
    textAlign: 'center',
    marginTop: 12,
  },
  recordAgainBtn: {
    width: '100%',
    paddingVertical: 14,
    alignItems: 'center',
  },
  recordAgainText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink2,
  },
});
