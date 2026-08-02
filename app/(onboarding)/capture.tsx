// S9 -- Guided first capture (docs/plans/onboarding-design-brief.md S9,
// docs/plans/onboarding-implementation.md WP2). Voice-first: a real
// `processOnboardingVoiceMemory` call over an anonymous session, with every
// failure mode degrading to typing -- this is the single highest-risk
// screen in the package (CLAUDE.md high-risk area, the keyboard must never
// cover the textarea or "Keep this one").
//
// The handoff's `OnbKeyboard` fake keyboard is NOT ported -- OnbShell's real
// KeyboardAwareScrollView handles keyboard avoidance for the compose state.
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Mic, Square, Type, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

import { OnbButton } from '@/components/onboarding/onb-button';
import { KidChip } from '@/components/onboarding/kid-chip';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { colors, fonts, radius } from '@/constants/theme';
import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { ensureAnonymousSession } from '@/lib/anonymous-session';
import { onboardingAhaRoute } from '@/lib/onboarding-routes';
import { processOnboardingVoiceMemory } from '@/services/ai';
import { trackEvent } from '@/services/analytics';
import type { MemberWithNames } from '@/utils/member-mentions';
import { capturePrompt } from '@/utils/onboarding-copy';
import { readLocalFileAsBase64 } from '@/utils/local-files';
import {
  getOrRequestNativePermission,
  waitForNativePresentationToSettle,
} from '@/utils/native-permissions';
import { MemoryMediaPicker, type MediaAttachment } from '@/components/memory-media-picker';

const MAX_RECORDING_MS = 2 * 60 * 1000;
const MAX_NAME_HINTS = 6;
const MAX_NAME_HINT_LENGTH = 50;

// Every onboarding voice failure -- ensureAnonymousSession failing,
// permission denial, a stopped-but-uriless recording, or any
// processOnboardingVoiceMemory error (ONBOARDING_ANONYMOUS_REQUIRED,
// ONBOARDING_VOICE_LIMIT_REACHED, ONBOARDING_VOICE_RESERVATION_FAILED,
// ONBOARDING_VOICE_CLEANUP_RESERVATION_FAILED, or a plain transcription/
// audio-validation error) -- degrades here identically: warm, never
// mentions quotas or limits (usage-limits.md design principle 1).
const TYPING_FALLBACK_NOTE = 'Typing works just as well.';

type CaptureMode = 'idle' | 'recording' | 'transcribing' | 'compose';

function buildNameHints(kidNames: string[]): string[] {
  return kidNames
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, MAX_NAME_HINTS)
    .map((name) => name.slice(0, MAX_NAME_HINT_LENGTH));
}

function WaveformBars() {
  const heights = useMemo(() => [10, 18, 26, 14, 30, 22, 12, 26, 18, 8, 20, 28, 14], []);
  const [values] = useState(() => heights.map(() => new Animated.Value(0.4)));

  useEffect(() => {
    const loops = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration: 550 + (index % 4) * 110,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: false,
          }),
          Animated.timing(value, {
            toValue: 0.4,
            duration: 550 + (index % 4) * 110,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: false,
          }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [values]);

  return (
    <View style={styles.waveformRow} testID="onboarding-capture-waveform">
      {heights.map((height, index) => (
        <Animated.View
          key={index}
          style={[
            styles.waveformBar,
            {
              height: values[index].interpolate({ inputRange: [0, 1], outputRange: [height * 0.4, height] }),
              opacity: values[index].interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
            },
          ]}
        />
      ))}
    </View>
  );
}

// Draft kids have no real `family_members` row yet (no family exists until
// commitOnboarding runs post-auth) -- these synthetic ids exist only to
// drive useAutoMemoryTags's matching/suppression logic locally in this
// screen and are the string form of the kid's index into `draft.kidNames`.
// They're mapped back to indexes for `selectedKidIndexes` and never leave
// this component (never sent to a server call; onboarding-routing's
// `taggedKidIndexes` stays index-based, same as before this change).
function kidMemberId(index: number): string {
  return String(index);
}

function kidIndexFromMemberId(id: string): number {
  return Number(id);
}

export default function OnboardingCaptureScreen() {
  const { draft, patch } = useOnboardingFlow();
  const kidNames = draft.kidNames;
  const isMulti = kidNames.length > 1;

  const [mode, setMode] = useState<CaptureMode>('idle');
  const [text, setText] = useState('');
  const [attachedMedia, setAttachedMedia] = useState<MediaAttachment | null>(null);
  const [fallbackNote, setFallbackNote] = useState('');
  const [mediaError, setMediaError] = useState('');
  // onboarding_capture_completed's method/transcription_failed properties
  // (docs/plans/analytics-implementation.md WP2.2) -- `mode` alone collapses
  // to 'compose' regardless of how the text got there, so these track the
  // voice pipeline's outcome independently: `usedVoice` flips true only on a
  // successful transcription; `voiceFailed` flips true on ANY degrade to
  // typing from the mic flow (fallBackToTyping below is only ever called
  // from within handleMicPress's voice attempt, never from the explicit
  // "I'd rather type" tap). Neither ever resets -- a retry that later
  // succeeds after an earlier failure should still report the failure.
  const [usedVoice, setUsedVoice] = useState(false);
  const [voiceFailed, setVoiceFailed] = useState(false);

  // Reuses the app's mention-matching/suppression logic (useAutoMemoryTags,
  // used by app/(app)/new-memory.tsx) so typing or speaking a kid's name
  // tags them automatically, the same way it works in the real app --
  // without ever needing a real family_members id pre-auth.
  const tagMembers = useMemo<MemberWithNames[]>(
    () => kidNames.map((name, index) => ({ id: kidMemberId(index), name })),
    [kidNames],
  );
  const { selectedMemberIds, initializeTags, applyForContent, toggleMember } = useAutoMemoryTags({
    members: tagMembers,
    enabled: true,
  });

  // Default preselection: every kid, not just the first-entered one (the
  // design brief's "first-entered kid pre-selected" produced an
  // uncomfortably narrow prompt for multi-kid families -- see
  // docs/plans/onboarding-design-brief.md S9 "Multi-kid variant"). Selecting
  // everyone lets capturePrompt's existing ladder ("the two of them" / "all
  // of them") do the phrasing instead of naming every child. Runs once,
  // as soon as the draft's kid names are available (hydration may still be
  // in flight on first render).
  const hasInitializedTagsRef = useRef(false);
  useEffect(() => {
    if (hasInitializedTagsRef.current || kidNames.length === 0) {
      return;
    }
    hasInitializedTagsRef.current = true;
    initializeTags(kidNames.map((_, index) => kidMemberId(index)));
  }, [kidNames, initializeTags]);

  const selectedKidIndexes = useMemo(
    () =>
      selectedMemberIds
        .map(kidIndexFromMemberId)
        .filter((index) => Number.isInteger(index) && index >= 0 && index < kidNames.length)
        .sort((a, b) => a - b),
    [selectedMemberIds, kidNames.length],
  );

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 500);

  useEffect(() => {
    void setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  }, []);

  useEffect(() => {
    if (!recorderState.isRecording) {
      return;
    }
    if (recorderState.durationMillis >= MAX_RECORDING_MS) {
      void recorder.stop();
    }
  }, [recorder, recorderState.durationMillis, recorderState.isRecording]);

  const nameHints = useMemo(() => buildNameHints(kidNames), [kidNames]);
  const prompt = capturePrompt(kidNames, selectedKidIndexes);
  const canKeep = text.trim().length > 0 || attachedMedia !== null;

  // Manual chip taps always win over auto-tagging: toggleMember records a
  // deselect in useAutoMemoryTags's suppressedMemberIds, so later typing or
  // a transcribed mention of that kid's name won't silently re-select them
  // (same contract as new-memory.tsx). Deselecting the sole remaining
  // selected kid is a no-op -- a memory can never end up tagged to nobody.
  const toggleKid = (index: number) => {
    const id = kidMemberId(index);
    const isSelected = selectedMemberIds.includes(id);
    if (isSelected && selectedMemberIds.length === 1) {
      return;
    }
    toggleMember(id);
  };

  const fallBackToTyping = (note: string = TYPING_FALLBACK_NOTE) => {
    setMode('compose');
    setFallbackNote(note);
    setVoiceFailed(true);
  };

  const handleMicPress = async () => {
    if (mode === 'idle') {
      setFallbackNote('');

      const { error: sessionError } = await ensureAnonymousSession();
      if (sessionError) {
        fallBackToTyping();
        return;
      }

      try {
        const { permission, didRequest } = await getOrRequestNativePermission(
          () => AudioModule.getRecordingPermissionsAsync(),
          () => AudioModule.requestRecordingPermissionsAsync(),
        );

        if (!permission.granted) {
          fallBackToTyping();
          return;
        }

        if (didRequest) {
          await waitForNativePresentationToSettle();
        }

        await recorder.prepareToRecordAsync();
        recorder.record();
        setMode('recording');
      } catch {
        fallBackToTyping();
      }
      return;
    }

    if (mode === 'recording') {
      setMode('transcribing');

      try {
        await recorder.stop();
        const uri = recorder.uri;

        if (!uri) {
          fallBackToTyping();
          return;
        }

        const base64 = await readLocalFileAsBase64(uri);
        const { data, error } = await processOnboardingVoiceMemory(base64, nameHints);

        if (error || !data) {
          fallBackToTyping();
          return;
        }

        setText(data.cleanedText);
        // The onboarding voice endpoint deliberately always returns
        // mentionedMemberIds: [] (docs/TECH_SPEC.md process-voice-memory --
        // nameHints are spelling hints only, never member ids, since no
        // family/member rows exist pre-auth). Run the same local
        // mention-matching applyForContent uses for typed text against the
        // transcript instead of trusting a server-provided match list, so a
        // kid mentioned by voice still gets auto-tagged.
        applyForContent(data.cleanedText);
        setFallbackNote('');
        setMode('compose');
        setUsedVoice(true);
      } catch {
        fallBackToTyping();
      }
    }
  };

  const handleTypeInstead = () => {
    setFallbackNote('');
    setMode('compose');
  };

  const handleTalkInstead = () => {
    setFallbackNote('');
    setMode('idle');
  };

  const handleAddMedia = (attachments: MediaAttachment[]) => {
    setMediaError('');
    const attachment = attachments[0];
    if (!attachment) {
      return;
    }
    setAttachedMedia(attachment);
    setMode('compose');
  };

  const handleRemoveMedia = () => {
    setAttachedMedia(null);
  };

  const handleTextChange = (value: string) => {
    setText(value);
    applyForContent(value);
  };

  const handleKeep = () => {
    if (!canKeep) {
      return;
    }

    trackEvent('onboarding_capture_completed', {
      method: usedVoice ? 'voice' : 'typed',
      has_media: attachedMedia !== null,
      transcription_failed: voiceFailed,
    });

    patch({
      capture: {
        text: text.trim(),
        mediaUri: attachedMedia?.uri,
        mediaContentType: attachedMedia?.contentType,
        // Same values new-memory.tsx stores from MediaAttachment -- see
        // OnboardingDraftCapture's doc comment for why this matters.
        mediaAspectRatio: attachedMedia?.aspectRatio,
        mediaDurationMs: attachedMedia?.durationMs,
        taggedKidIndexes: selectedKidIndexes,
      },
      step: 'aha',
    });
    router.push(onboardingAhaRoute);
  };

  const isComposing = mode === 'compose';

  return (
    <OnbShell
      footer={
        isComposing ? (
          <View style={styles.composeToolbar}>
            <Pressable onPress={handleTalkInstead} style={styles.toolbarPill} testID="onboarding-capture-talk-instead">
              <Mic color={colors.ink2} size={14} />
              <OnbBody muted size={12.5}>Talk instead</OnbBody>
            </Pressable>
            {!attachedMedia ? (
              <MemoryMediaPicker
                compact
                onError={setMediaError}
                onSelect={handleAddMedia}
                remainingSlots={1}
              />
            ) : null}
            <View style={styles.footerSpacer} />
            <OnbButton
              disabled={!canKeep}
              label="Keep this one"
              onPress={handleKeep}
              size="md"
              testID="onboarding-capture-keep"
            />
          </View>
        ) : mode === 'idle' ? (
          // Media attachment deliberately isn't offered here -- this screen's
          // job is capturing the moment, and the very next state (compose,
          // just above) already has a media button (see
          // docs/plans/onboarding-design-brief.md S9: "Tertiary: Add a photo
          // or video" moved off the idle/recording state per owner decision).
          <View style={styles.idleFooter}>
            <Pressable onPress={handleTypeInstead} style={styles.secondaryPill} testID="onboarding-capture-type-instead">
              <Type color={colors.ink} size={15} />
              <OnbBody size={13.5}>I&rsquo;d rather type</OnbBody>
            </Pressable>
            <OnbBody muted size={12.5} style={styles.reassurance}>
              Twenty seconds of rambling is plenty. Grammar optional.
            </OnbBody>
          </View>
        ) : null
      }
    >
      {isMulti ? (
        <View style={styles.kidChipsRow} testID="onboarding-capture-kid-chips">
          {kidNames.map((name, index) => (
            <KidChip
              index={index}
              key={`${name}-${index}`}
              name={name}
              onPress={() => toggleKid(index)}
              selected={selectedKidIndexes.includes(index)}
              testID={`onboarding-capture-kid-chip-${index}`}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.promptWrap}>
        <OnbDisplay size={27}>{prompt}</OnbDisplay>
      </View>

      {mediaError ? (
        <OnbBody size={13} style={styles.errorText} testID="onboarding-capture-media-error">
          {mediaError}
        </OnbBody>
      ) : null}

      {isComposing ? (
        <View style={styles.composeBody}>
          {attachedMedia ? (
            <View style={styles.photoThumbWrap}>
              <Image
                accessibilityLabel="Attached photo"
                contentFit="cover"
                source={{ uri: attachedMedia.uri }}
                style={styles.photoThumb}
              />
              <Pressable
                accessibilityLabel="Remove photo"
                accessibilityRole="button"
                onPress={handleRemoveMedia}
                style={styles.photoRemoveBtn}
                testID="onboarding-capture-remove-photo"
              >
                <X color={colors.white} size={13} strokeWidth={2.5} />
              </Pressable>
            </View>
          ) : null}

          {fallbackNote ? (
            <OnbBody muted size={13} style={styles.fallbackNote} testID="onboarding-capture-fallback-note">
              {fallbackNote}
            </OnbBody>
          ) : null}

          <TextInput
            multiline
            onChangeText={handleTextChange}
            placeholder={attachedMedia ? 'Add a caption (optional)' : 'Type it out…'}
            placeholderTextColor={colors.ink3}
            style={[styles.textarea, attachedMedia ? styles.textareaWithMedia : null]}
            testID="onboarding-capture-textarea"
            value={text}
          />
        </View>
      ) : (
        <View style={styles.micStage}>
          <View style={styles.micHaloWrap}>
            <View style={[styles.micHaloOuter, mode === 'recording' && styles.micHaloOuterActive]} />
            <View style={[styles.micHaloInner, mode === 'recording' && styles.micHaloInnerActive]} />
            <Pressable
              accessibilityLabel={mode === 'recording' ? 'Stop recording' : 'Tap and talk'}
              accessibilityRole="button"
              disabled={mode === 'transcribing'}
              onPress={handleMicPress}
              style={[styles.micButton, mode === 'recording' && styles.micButtonRecording]}
              testID="onboarding-capture-mic"
            >
              {mode === 'transcribing' ? (
                <ActivityIndicator color={colors.white} />
              ) : mode === 'recording' ? (
                <Square color={colors.primary} fill={colors.primary} size={22} />
              ) : (
                <Mic color={colors.white} size={32} />
              )}
            </Pressable>
          </View>

          <View style={styles.micCaption}>
            {mode === 'idle' ? (
              <>
                <OnbBody size={15} style={styles.micCaptionTitle}>Tap and talk</OnbBody>
                <OnbScript color={colors.ink2} size={20}>say it like you&rsquo;d text your best friend</OnbScript>
              </>
            ) : null}
            {mode === 'recording' ? (
              <>
                <WaveformBars />
                <OnbBody muted size={13.5} style={styles.micCaptionSpacing}>Listening. Take your time.</OnbBody>
              </>
            ) : null}
            {mode === 'transcribing' ? (
              <>
                <OnbBody size={15} style={styles.micCaptionTitle}>One second…</OnbBody>
                <OnbBody muted size={13} style={styles.micCaptionSpacing}>Turning your words into a page.</OnbBody>
              </>
            ) : null}
          </View>
        </View>
      )}
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  kidChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  promptWrap: {
    paddingHorizontal: 26,
    paddingTop: 18,
  },
  errorText: {
    color: colors.error,
    paddingHorizontal: 26,
    paddingTop: 10,
  },
  micStage: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  micHaloWrap: {
    alignItems: 'center',
    height: 230,
    justifyContent: 'center',
    width: 230,
  },
  micHaloOuter: {
    backgroundColor: colors.primaryTint,
    borderRadius: 999,
    height: 195,
    position: 'absolute',
    width: 195,
  },
  micHaloOuterActive: {
    backgroundColor: colors.primarySoft,
  },
  micHaloInner: {
    backgroundColor: colors.primarySoft,
    borderRadius: 999,
    height: 160,
    opacity: 0.8,
    position: 'absolute',
    width: 160,
  },
  micHaloInnerActive: {
    opacity: 1,
  },
  micButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 999,
    elevation: 6,
    height: 94,
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    width: 94,
  },
  micButtonRecording: {
    backgroundColor: colors.white,
  },
  micCaption: {
    alignItems: 'center',
    marginTop: 26,
    minHeight: 80,
  },
  micCaptionTitle: {
    fontWeight: '700',
  },
  micCaptionSpacing: {
    marginTop: 8,
  },
  waveformRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 3.5,
    height: 34,
    justifyContent: 'center',
  },
  waveformBar: {
    backgroundColor: colors.primary,
    borderRadius: 999,
    width: 4,
  },
  composeBody: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 18,
  },
  photoThumbWrap: {
    height: 130,
    marginBottom: 14,
    width: 130,
  },
  photoThumb: {
    borderRadius: radius.md,
    height: '100%',
    width: '100%',
  },
  photoRemoveBtn: {
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 999,
    height: 24,
    justifyContent: 'center',
    position: 'absolute',
    right: -7,
    top: -7,
    width: 24,
  },
  fallbackNote: {
    marginBottom: 10,
  },
  textarea: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.display,
    fontSize: 21,
    lineHeight: 21 * 1.45,
    textAlignVertical: 'top',
  },
  textareaWithMedia: {
    flex: 0,
    minHeight: 90,
  },
  composeToolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  toolbarPill: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  footerSpacer: {
    flex: 1,
  },
  idleFooter: {
    alignItems: 'center',
    gap: 12,
  },
  secondaryPill: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  reassurance: {
    textAlign: 'center',
  },
});
