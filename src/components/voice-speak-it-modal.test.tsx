import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { ClipChip } from '@/components/audio/clip-chip';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { trackEvent } from '@/services/analytics';
import { claimAudioClip } from '@/utils/audio-clip-custody';

import { VoiceSpeakItModal } from './voice-speak-it-modal';

jest.mock('@/hooks/useVoiceInput', () => ({
  MAX_RECORDING_MS: 120000,
  useVoiceInput: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: () => ({ familyId: 'family-1' }),
}));

jest.mock('@/hooks/useAudioClipPlayback', () => ({
  useAudioClipPlayback: jest.fn(),
}));

jest.mock('@/utils/audio-clip-custody', () => ({
  claimAudioClip: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

// Native loudness analysis (docs/plans/audio-trim-import.md): absent by
// default, like an older binary; the "real waveform" tests turn it on.
const mockAudioIsAvailable = jest.fn(() => false);
const mockAudioAnalyze = jest.fn();
jest.mock('../../modules/momora-audio', () => ({
  isAvailable: () => mockAudioIsAvailable(),
  analyze: (...args: unknown[]) => mockAudioAnalyze(...args),
}));

const mockedUseVoiceInput = useVoiceInput as jest.MockedFunction<typeof useVoiceInput>;
const mockedUseAudioClipPlayback = useAudioClipPlayback as jest.MockedFunction<typeof useAudioClipPlayback>;
const mockedClaimAudioClip = claimAudioClip as jest.MockedFunction<typeof claimAudioClip>;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

function baseHookReturn(overrides: Partial<ReturnType<typeof useVoiceInput>> = {}): ReturnType<typeof useVoiceInput> {
  return {
    isRecording: false,
    durationMillis: 0,
    durationLabel: '0:00',
    errorMessage: '',
    stoppedClip: null,
    autoStopped: false,
    transcriptionStatus: 'idle',
    transcriptionResult: null,
    transcriptionPromise: null,
    startRecording: jest.fn().mockResolvedValue(undefined),
    stopRecording: jest.fn().mockResolvedValue(undefined),
    discardStoppedClip: jest.fn().mockResolvedValue(undefined),
    recordAgain: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ReturnType<typeof useVoiceInput>;
}

function present(screen: ReturnType<typeof render>) {
  fireEvent(screen.getByTestId('voice-speak-it-modal'), 'show');
}

describe('VoiceSpeakItModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAudioClipPlayback.mockReturnValue({
      playing: false,
      position: 0,
      duration: 0,
      progress: 0,
      loading: false,
      error: null,
      toggle: jest.fn().mockResolvedValue(undefined),
      seekTo: jest.fn().mockResolvedValue(undefined),
    });
    mockedClaimAudioClip.mockResolvedValue('file:///documents/audio-recordings/claimed.m4a');
    mockAudioIsAvailable.mockReturnValue(false);
    mockAudioAnalyze.mockReset();
  });

  it('waits for the native modal to finish presenting before requesting microphone access', async () => {
    const startRecording = jest.fn().mockResolvedValue(undefined);
    mockedUseVoiceInput.mockReturnValue(baseHookReturn({ startRecording }));

    const screen = render(
      <VoiceSpeakItModal
        familyMembers={[]}
        onDismiss={jest.fn()}
        onResult={jest.fn()}
        visible
      />,
    );

    expect(startRecording).not.toHaveBeenCalled();
    expect(mockedUseVoiceInput).toHaveBeenCalledWith([], 'family-1');
    present(screen);

    await waitFor(() => expect(startRecording).toHaveBeenCalledTimes(1));
  });

  describe('captureMode="dictate" (default -- edit-screen dictation)', () => {
    it('shows no fork, applies the transcript, and discards the file once transcription resolves', async () => {
      const onResult = jest.fn();
      const onDismiss = jest.fn();
      const discardStoppedClip = jest.fn().mockResolvedValue(undefined);
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
          discardStoppedClip,
        }),
      );

      const screen = render(
        <VoiceSpeakItModal
          captureMode="dictate"
          familyMembers={[]}
          onDismiss={onDismiss}
          onResult={onResult}
          visible
        />,
      );
      present(screen);

      expect(screen.queryByTestId('voice-speak-it-fork')).toBeNull();
      await waitFor(() => expect(onResult).toHaveBeenCalledWith({
        cleanedText: 'hello',
        description: 'a hello',
        mentionedMemberIds: [],
      }));
      expect(discardStoppedClip).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('defaults to dictate when captureMode is omitted (edit.tsx does not pass one)', async () => {
      const onResult = jest.fn();
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
        }),
      );

      const screen = render(
        <VoiceSpeakItModal
          familyMembers={[]}
          onDismiss={jest.fn()}
          onResult={onResult}
          visible
        />,
      );
      present(screen);

      expect(screen.queryByTestId('voice-speak-it-fork')).toBeNull();
      await waitFor(() => expect(onResult).toHaveBeenCalled());
    });
  });

  describe('captureMode="fork" (composer, first recording)', () => {
    it('shows the equal-weight fork once stopped, with neither button pre-selected', async () => {
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
        }),
      );

      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={jest.fn()}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      expect(screen.getByTestId('voice-speak-it-fork')).toBeTruthy();
      expect(screen.getByTestId('voice-speak-it-choose-text')).toBeTruthy();
      expect(screen.getByTestId('voice-speak-it-keep-sound')).toBeTruthy();
      expect(screen.getByTestId('voice-speak-it-record-again')).toBeTruthy();
      expect(mockedTrackEvent).toHaveBeenCalledWith('voice_fork_shown', { auto_stopped: false });
    });

    it('turning into text with an already-resolved transcript applies it immediately, with zero wait', async () => {
      const onResult = jest.fn();
      const onDismiss = jest.fn();
      const discardStoppedClip = jest.fn().mockResolvedValue(undefined);
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
          discardStoppedClip,
        }),
      );

      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={onDismiss}
          onKeepSound={jest.fn()}
          onResult={onResult}
          visible
        />,
      );
      present(screen);

      fireEvent.press(screen.getByTestId('voice-speak-it-choose-text'));

      expect(mockedTrackEvent).toHaveBeenCalledWith('voice_fork_choice', { choice: 'turn_into_text' });
      await waitFor(() => expect(onResult).toHaveBeenCalledWith({
        cleanedText: 'hello',
        description: 'a hello',
        mentionedMemberIds: [],
      }));
      expect(discardStoppedClip).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('turning into text while still transcribing shows the waiting treatment, and keep stays enabled', async () => {
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'transcribing',
          transcriptionResult: null,
        }),
      );

      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={jest.fn()}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      fireEvent.press(screen.getByTestId('voice-speak-it-choose-text'));

      expect(screen.getByText('still catching your words')).toBeTruthy();
      // Keep the sound must remain fully enabled while text is waiting.
      expect(screen.getByTestId('voice-speak-it-keep-sound').props.accessibilityState?.disabled).not.toBe(true);
    });

    it('transcription failure dims "Turn into text" and emphasizes "Keep the sound", which stays fully functional', async () => {
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'failed',
          transcriptionResult: null,
        }),
      );

      const onKeepSound = jest.fn();
      const onDismiss = jest.fn();
      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={onDismiss}
          onKeepSound={onKeepSound}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      expect(screen.getByText('couldn’t catch the words')).toBeTruthy();
      expect(screen.getByTestId('voice-speak-it-choose-text').props.accessibilityState.disabled).toBe(true);

      await act(async () => {
        fireEvent.press(screen.getByTestId('voice-speak-it-keep-sound'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockedClaimAudioClip).toHaveBeenCalledWith('file:///cache/rec.m4a');
      expect(onKeepSound).toHaveBeenCalledWith(
        expect.objectContaining({ localUri: 'file:///documents/audio-recordings/claimed.m4a' }),
      );
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('keeping the sound claims the clip, hands it to onKeepSound, and never discards the file', async () => {
      const discardStoppedClip = jest.fn().mockResolvedValue(undefined);
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 8000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: ['m1'] },
          discardStoppedClip,
        }),
      );

      const onKeepSound = jest.fn();
      const onDismiss = jest.fn();
      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={onDismiss}
          onKeepSound={onKeepSound}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      await act(async () => {
        fireEvent.press(screen.getByTestId('voice-speak-it-keep-sound'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockedTrackEvent).toHaveBeenCalledWith('voice_fork_choice', { choice: 'keep_the_sound' });
      expect(mockedClaimAudioClip).toHaveBeenCalledWith('file:///cache/rec.m4a');
      expect(onKeepSound).toHaveBeenCalledWith({
        localUri: 'file:///documents/audio-recordings/claimed.m4a',
        durationMs: 8000,
        transcriptionStatus: 'done',
        transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: ['m1'] },
        pendingTranscription: null,
      });
      expect(discardStoppedClip).not.toHaveBeenCalled();
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('passes the in-flight transcription promise through when keeping mid-transcription', async () => {
      const pendingPromise = Promise.resolve({ cleanedText: 'x', description: 'y', mentionedMemberIds: [] });
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 8000 },
          transcriptionStatus: 'transcribing',
          transcriptionResult: null,
          transcriptionPromise: pendingPromise,
        }),
      );

      const onKeepSound = jest.fn();
      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={onKeepSound}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      await act(async () => {
        fireEvent.press(screen.getByTestId('voice-speak-it-keep-sound'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onKeepSound).toHaveBeenCalledWith(
        expect.objectContaining({ pendingTranscription: pendingPromise }),
      );
    });

    it('carries a mid-fork transcription resolution (transcribing -> done while the user sits at the fork) into the Keep payload', async () => {
      // Regression test for a device-confirmed bug: the user sits at the
      // fork long enough for transcription to resolve *before* tapping
      // "Keep the sound" -- distinct from the already-covered "already
      // done at mount" tests above (which never exercise a live
      // transcribing->done transition) and from "mid-transcription" above
      // (which keeps while still pending). handleKeepSound reads
      // transcriptionStatus/transcriptionResult fresh off this render's
      // closure, so the re-render triggered by the status flip must carry
      // through correctly by the time Keep is tapped.
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 8000 },
          transcriptionStatus: 'transcribing',
          transcriptionResult: null,
        }),
      );

      const onKeepSound = jest.fn();
      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={onKeepSound}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      // Transcription resolves while the fork is still showing -- simulates
      // useVoiceInput's own setState-driven re-render once the in-flight
      // call settles, well before the user taps anything.
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 8000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello there', description: 'a lovely description', mentionedMemberIds: [] },
        }),
      );
      screen.rerender(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={onKeepSound}
          onResult={jest.fn()}
          visible
        />,
      );

      await act(async () => {
        fireEvent.press(screen.getByTestId('voice-speak-it-keep-sound'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onKeepSound).toHaveBeenCalledWith(
        expect.objectContaining({
          transcriptionResult: { cleanedText: 'hello there', description: 'a lovely description', mentionedMemberIds: [] },
          pendingTranscription: null,
        }),
      );
    });

    it('"Record again" discards the current clip and restarts recording', async () => {
      const recordAgain = jest.fn().mockResolvedValue(undefined);
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
          recordAgain,
        }),
      );

      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={jest.fn()}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      await act(async () => {
        fireEvent.press(screen.getByTestId('voice-speak-it-record-again'));
      });

      expect(recordAgain).toHaveBeenCalledTimes(1);
    });

    it('cancel with a stopped-but-not-kept clip discards the file before dismissing', async () => {
      const discardStoppedClip = jest.fn().mockResolvedValue(undefined);
      const onDismiss = jest.fn();
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
          discardStoppedClip,
        }),
      );

      const screen = render(
        <VoiceSpeakItModal
          captureMode="fork"
          familyMembers={[]}
          onDismiss={onDismiss}
          onKeepSound={jest.fn()}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      await act(async () => {
        fireEvent.press(screen.getByTestId('voice-speak-it-cancel'));
      });

      expect(discardStoppedClip).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  describe('captureMode="keepOnly" (composer, re-record replaces the attached clip)', () => {
    it('shows no fork at all once stopped -- the stop action itself keeps the clip', async () => {
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
        }),
      );

      const onKeepSound = jest.fn();
      const screen = render(
        <VoiceSpeakItModal
          captureMode="keepOnly"
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={onKeepSound}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByTestId('voice-speak-it-fork')).toBeNull();
      expect(screen.queryByTestId('voice-speak-it-choose-text')).toBeNull();
      expect(screen.queryByTestId('voice-speak-it-keep-sound')).toBeNull();
      expect(onKeepSound).toHaveBeenCalled();
    });

    it('claims and hands off the clip automatically on stop, with no user interaction, regardless of transcription state', async () => {
      const discardStoppedClip = jest.fn().mockResolvedValue(undefined);
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 6000 },
          transcriptionStatus: 'failed',
          transcriptionResult: null,
          discardStoppedClip,
        }),
      );

      const onKeepSound = jest.fn();
      const onDismiss = jest.fn();
      const screen = render(
        <VoiceSpeakItModal
          captureMode="keepOnly"
          familyMembers={[]}
          onDismiss={onDismiss}
          onKeepSound={onKeepSound}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockedClaimAudioClip).toHaveBeenCalledWith('file:///cache/rec.m4a');
      expect(onKeepSound).toHaveBeenCalledWith({
        localUri: 'file:///documents/audio-recordings/claimed.m4a',
        durationMs: 6000,
        transcriptionStatus: 'failed',
        transcriptionResult: null,
        pendingTranscription: null,
      });
      expect(discardStoppedClip).not.toHaveBeenCalled();
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('never fires voice_fork_shown/voice_fork_choice -- there was no fork to choose from', async () => {
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
        }),
      );

      const screen = render(
        <VoiceSpeakItModal
          captureMode="keepOnly"
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={jest.fn()}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockedTrackEvent).not.toHaveBeenCalledWith('voice_fork_shown', expect.anything());
      expect(mockedTrackEvent).not.toHaveBeenCalledWith('voice_fork_choice', expect.anything());
    });
  });
  describe('real waveform of the stopped clip', () => {
    const energies = {
      durationMs: 4000,
      bucketMs: 100,
      energies: Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.1 : 0.001)),
    };

    function renderFork(captureMode: 'fork' | 'keepOnly' | 'dictate', onKeepSound = jest.fn()) {
      mockedUseVoiceInput.mockReturnValue(
        baseHookReturn({
          stoppedClip: { localUri: 'file:///cache/rec.m4a', durationMs: 4000 },
          transcriptionStatus: 'done',
          transcriptionResult: { cleanedText: 'hello', description: 'a hello', mentionedMemberIds: [] },
        }),
      );
      const screen = render(
        <VoiceSpeakItModal
          captureMode={captureMode}
          familyMembers={[]}
          onDismiss={jest.fn()}
          onKeepSound={onKeepSound}
          onResult={jest.fn()}
          visible
        />,
      );
      present(screen);
      return screen;
    }

    it('analyses the stopped clip and draws its real waveform in the chip', async () => {
      mockAudioIsAvailable.mockReturnValue(true);
      mockAudioAnalyze.mockResolvedValue(energies);
      const screen = renderFork('fork');
      expect(screen.getByTestId('voice-speak-it-clip-chip')).toBeTruthy();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockAudioAnalyze).toHaveBeenCalledWith('file:///cache/rec.m4a', { maxBuckets: 4000, minBucketMs: 20 });
      expect(mockAudioAnalyze).toHaveBeenCalledTimes(1);
      const waveform = screen.UNSAFE_getByType(ClipChip).props.waveform as number[];
      expect(waveform).toHaveLength(64);
      expect(Math.max(...waveform)).toBe(255);
    });

    it('draws the seeded trace (no waveform) until the analysis lands, and without the module', async () => {
      const screen = renderFork('fork');
      expect(screen.UNSAFE_getByType(ClipChip).props.waveform ?? null).toBeNull();
    });

    it('hands the analysis promise to the composer on keep, so it is not decoded twice', async () => {
      mockAudioIsAvailable.mockReturnValue(true);
      const analysis = Promise.resolve(energies);
      mockAudioAnalyze.mockReturnValue(analysis);
      const onKeepSound = jest.fn();
      const screen = renderFork('fork', onKeepSound);

      await act(async () => {
        fireEvent.press(screen.getByTestId('voice-speak-it-keep-sound'));
        await Promise.resolve();
        await Promise.resolve();
      });

      const kept = onKeepSound.mock.calls[0][0] as { pendingAnalysis?: Promise<unknown> };
      await expect(kept.pendingAnalysis).resolves.toEqual(energies);
      expect(mockAudioAnalyze).toHaveBeenCalledTimes(1);
    });

    it('a failed analysis resolves null and never blocks keeping the sound', async () => {
      mockAudioIsAvailable.mockReturnValue(true);
      mockAudioAnalyze.mockRejectedValue(new Error('decode_failed'));
      const onKeepSound = jest.fn();
      const screen = renderFork('fork', onKeepSound);

      await act(async () => {
        fireEvent.press(screen.getByTestId('voice-speak-it-keep-sound'));
        await Promise.resolve();
        await Promise.resolve();
      });

      const kept = onKeepSound.mock.calls[0][0] as { pendingAnalysis?: Promise<unknown> };
      await expect(kept.pendingAnalysis).resolves.toBeNull();
    });

    it('keepOnly hands the analysis over too', async () => {
      mockAudioIsAvailable.mockReturnValue(true);
      mockAudioAnalyze.mockResolvedValue(energies);
      const onKeepSound = jest.fn();
      renderFork('keepOnly', onKeepSound);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onKeepSound).toHaveBeenCalledTimes(1);
      expect((onKeepSound.mock.calls[0][0] as { pendingAnalysis?: unknown }).pendingAnalysis).toBeDefined();
    });

    it('never analyses without the native module, nor for plain dictation', async () => {
      const onKeepSound = jest.fn();
      const forkScreen = renderFork('fork', onKeepSound);
      await act(async () => {
        fireEvent.press(forkScreen.getByTestId('voice-speak-it-keep-sound'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAudioAnalyze).not.toHaveBeenCalled();
      expect(onKeepSound.mock.calls[0][0]).not.toHaveProperty('pendingAnalysis');
      forkScreen.unmount();

      mockAudioIsAvailable.mockReturnValue(true);
      renderFork('dictate');
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockAudioAnalyze).not.toHaveBeenCalled();
    });
  });
});
