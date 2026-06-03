import { useEffect, useRef } from 'react';
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

import { colors, fonts } from '@/constants/theme';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import type { VoiceFamilyMemberPayload } from '@/services/ai';

// Teal accent used only on this screen — matches the design mock
const TEAL = '#6AAEAA';
const MIC_SIZE = 88;
const RING_SIZE = MIC_SIZE * 1.7; // base size of each ring

interface VoiceSpeakItModalProps {
  visible: boolean;
  familyMembers: VoiceFamilyMemberPayload[];
  onDismiss: () => void;
  onResult: (result: { cleanedText: string; mentionedMemberIds: string[] }) => void;
}

// Inner content is a separate component so the hook only mounts when visible=true
function VoiceSpeakItContent({
  familyMembers,
  onDismiss,
  onResult,
}: Omit<VoiceSpeakItModalProps, 'visible'>) {
  const { isRecording, isProcessing, durationLabel, errorMessage, startRecording, stopRecording } =
    useVoiceInput(familyMembers);

  // Auto-start recording as soon as this component mounts
  useEffect(() => {
    void startRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleTap = async () => {
    if (isProcessing || !isRecording) return;
    const result = await stopRecording();
    if (result) {
      onResult(result);
      onDismiss();
    }
  };

  // Interpolated ring transforms
  const ring1Scale = ring1.interpolate({ inputRange: [0, 1], outputRange: [1, 1.85] });
  const ring1Opacity = ring1.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });
  const ring2Scale = ring2.interpolate({ inputRange: [0, 1], outputRange: [1, 1.85] });
  const ring2Opacity = ring2.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0] });

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable
          disabled={isProcessing}
          onPress={onDismiss}
          style={styles.cancelBtn}
          accessibilityRole="button"
          accessibilityLabel="Cancel voice recording"
        >
          <Text style={[styles.cancelText, isProcessing && styles.cancelTextDisabled]}>
            Cancel
          </Text>
        </Pressable>

        <Text style={styles.title}>SPEAK IT</Text>

        {/* Spacer to keep title centred */}
        <View style={styles.headerSpacer} />
      </View>

      {/* ── Main content ── */}
      <View style={styles.content}>
        {/* Animated mic button + rings */}
        <View style={styles.micArea}>
          {/* Outer ring */}
          <Animated.View
            style={[
              styles.ring,
              { transform: [{ scale: ring2Scale }], opacity: ring2Opacity },
            ]}
          />
          {/* Inner ring */}
          <Animated.View
            style={[
              styles.ring,
              { transform: [{ scale: ring1Scale }], opacity: ring1Opacity },
            ]}
          />
          {/* Centre button */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop recording"
            disabled={isProcessing}
            onPress={() => { void handleTap(); }}
            style={[styles.micBtn, isProcessing && styles.micBtnProcessing]}
          >
            {isProcessing ? (
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
        </View>

        {/* Prompt text */}
        <Text style={styles.prompt}>
          {isProcessing ? 'Transcribing…' : 'Tell me what happened.'}
        </Text>

        {/* Timer / instruction */}
        <Text style={styles.instruction}>
          {isProcessing
            ? ''
            : isRecording
              ? durationLabel
              : 'Tap to stop. Max 2 minutes.'}
        </Text>

        {errorMessage ? (
          <Text style={styles.errorText}>{errorMessage}</Text>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

export function VoiceSpeakItModal({
  visible,
  familyMembers,
  onDismiss,
  onResult,
}: VoiceSpeakItModalProps) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onDismiss}
      statusBarTranslucent={false}
      visible={visible}
    >
      {/* Only mount the content (and the hook) when the modal is actually open */}
      {visible ? (
        <VoiceSpeakItContent
          familyMembers={familyMembers}
          onDismiss={onDismiss}
          onResult={onResult}
        />
      ) : null}
    </Modal>
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
  cancelTextDisabled: {
    color: colors.ink3,
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
  micArea: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 40,
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
  prompt: {
    fontFamily: fonts.display,
    fontSize: 26,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 10,
  },
  instruction: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.ink3,
    textAlign: 'center',
    letterSpacing: 0.1,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
    textAlign: 'center',
    marginTop: 16,
    paddingHorizontal: 32,
  },
});
