// Compact toolbar button that launches the native document scanner for
// artwork (docs/plans/artwork-scanning.md, 3.3). Sits beside the mic and
// `MemoryMediaPicker` in the composer toolbar and mirrors the picker's
// compact style, disabled styling, and "report failures to the parent, which
// renders them inline" contract.
//
// Hidden entirely when `isArtworkScannerAvailable()` is false (OTA bundles
// reaching binaries built before the native module existed).
//
// The first tap on a device shows `ArtworkIntroSheet` (docs/plans/
// artwork-scanning-v2.md decision 7) instead of scanning; "Start scanning"
// opens the scanner once that sheet has fully dismissed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text } from 'react-native';

import { ArtworkIntroSheet } from '@/components/artwork/artwork-intro-sheet';
import { ScanArtIcon } from '@/components/icons/composer-icons';
import type { MediaAttachment } from '@/components/memory-media-picker';
import { colors, fonts } from '@/constants/theme';
import { trackEvent } from '@/services/analytics';
import { isArtworkScannerAvailable, scanArtwork } from '@/services/artwork-scanner';
import { deleteArtworkScanFile } from '@/utils/artwork-scan-custody';
import { MAX_MEMORY_MEDIA_ASSETS } from '@/utils/memories';
import {
  getOrRequestNativePermission,
  waitForNativePresentationToSettle,
} from '@/utils/native-permissions';

/** How long after the app returns to `active` we wait for the scanner's
 * result before concluding it was lost (Android activity death, iOS hang)
 * and releasing the re-entry guard. */
export const ARTWORK_SCAN_RESULT_GRACE_MS = 1500;

/** AsyncStorage flag: the first-time "hang it on the wall" intro has been
 * shown on this device (docs/plans/artwork-scanning-v2.md decision 7). */
export const ARTWORK_INTRO_SEEN_STORAGE_KEY = 'momora.artwork.introSeen.v1';

/** Upper bound on waiting for the intro sheet's `onDismissed` before the
 * scanner opens anyway (a Modal whose dismiss callback never arrives must not
 * strand the "Start scanning" tap). */
export const ARTWORK_INTRO_DISMISS_TIMEOUT_MS = 1500;

/** Storage errors count as "seen": they must never block scanning. */
async function readIntroSeen(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ARTWORK_INTRO_SEEN_STORAGE_KEY)) !== null;
  } catch {
    return true;
  }
}

async function writeIntroSeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(ARTWORK_INTRO_SEEN_STORAGE_KEY, '1');
  } catch {
    // Best-effort: worst case the intro shows once more.
  }
}

/** Imperative entry point for callers that skip the button tap (app shortcuts). */
export interface ArtworkScanButtonHandle {
  /** Runs the button's press handler; a no-op while disabled or when the scanner is unavailable. */
  startScan: () => void;
}

export interface ArtworkScanButtonProps {
  /** Receives validated pages whose files live in `artwork-scans/`. The
   * parent owns them from here: it must delete their files if it discards
   * them (see `deleteArtworkScanFile`). */
  onScanned: (attachments: MediaAttachment[]) => void;
  /** Failures, rendered inline by the parent exactly like the media picker's. */
  onError: (message: string) => void;
  /** Non-error information (iOS cap hint, dropped/rejected page counts).
   * An empty string clears it. Rendered inline by the parent, e.g. with
   * `ArtworkScanNotice`. */
  onNotice?: (message: string) => void;
  disabled?: boolean;
  remainingSlots?: number;
  testID?: string;
}

/**
 * Page-cap copy. iOS VisionKit has no page-limit API, so on iOS the cap is
 * enforced by truncating after the fact; this note is shown the moment the
 * button is tapped (and stays until the scan resolves) so the limit is
 * stated rather than silently applied. Android enforces the cap inside the
 * scanner UI itself.
 */
export function describeScanCap(pageLimit: number): string {
  return `Scan up to ${pageLimit} ${pageLimit === 1 ? 'piece' : 'pieces'}. Extra pages are left out.`;
}

function describeScanError(error: unknown): string {
  // `ArtworkScanError.code` (scanner_unavailable | scanner_busy | scanner_failed).
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'scanner_unavailable':
      // Android can report this transiently (first use downloads the ML Kit
      // scanner module and needs a connection) -- never worded as permanent.
      return "The scanner isn't ready yet. Check your connection and try again.";
    case 'scanner_busy':
      return 'The scanner is already open. Finish or close it, then try again.';
    default:
      return "Couldn't scan that. Please try again.";
  }
}

function describeScanOutcome(params: {
  droppedCount: number;
  rejectedCount: number;
  validationError: string | null;
}): string {
  const parts: string[] = [];
  if (params.droppedCount > 0) {
    parts.push(
      `A memory holds up to ${MAX_MEMORY_MEDIA_ASSETS} pieces, so ${params.droppedCount} extra ${
        params.droppedCount === 1 ? 'page was' : 'pages were'
      } left out.`,
    );
  }
  if (params.rejectedCount > 0) {
    const reason = params.validationError ? ` ${params.validationError}` : '';
    parts.push(
      `${params.rejectedCount} ${params.rejectedCount === 1 ? 'page' : 'pages'} couldn't be added.${reason}`,
    );
  }
  return parts.join(' ');
}

export const ArtworkScanButton = forwardRef<ArtworkScanButtonHandle, ArtworkScanButtonProps>(function ArtworkScanButton({
  onScanned,
  onError,
  onNotice,
  disabled = false,
  remainingSlots = MAX_MEMORY_MEDIA_ASSETS,
  testID = 'new-memory-scan-artwork',
}, ref) {
  // Always call the latest parent callbacks: the scan can take minutes and
  // resolves long after the render that created this closure.
  const onScannedRef = useRef(onScanned);
  const onErrorRef = useRef(onError);
  const onNoticeRef = useRef(onNotice);
  useEffect(() => {
    onScannedRef.current = onScanned;
    onErrorRef.current = onError;
    onNoticeRef.current = onNotice;
  });

  // Re-entry guard. `activeScanRef` is the token of the in-flight scan (null
  // when idle); a stale scan's `finally` can't release a newer scan's guard.
  const activeScanRef = useRef<number | null>(null);
  const nextScanTokenRef = useRef(1);
  const isMountedRef = useRef(true);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // First-time intro. The sheet is mounted lazily (first show) and then stays
  // mounted so its dismissal callback can still arrive. The re-entry guard
  // stays held (`introTokenRef`) from the tap until the sheet is dismissed
  // without starting, or the scan it hands off to finishes.
  const [introMounted, setIntroMounted] = useState(false);
  const [introVisible, setIntroVisible] = useState(false);
  const introTokenRef = useRef<number | null>(null);
  const introStartRequestedRef = useRef(false);
  const introTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;

    const clearGraceTimer = () => {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
    };

    // A lost Android activity result (or an iOS hang) would otherwise leave
    // the guard set forever. When the app comes back to the foreground and
    // the scan still hasn't resolved after a short grace period, release it.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        return;
      }
      const tokenAtResume = activeScanRef.current;
      if (tokenAtResume === null) {
        return;
      }
      clearGraceTimer();
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        if (activeScanRef.current === tokenAtResume) {
          activeScanRef.current = null;
        }
      }, ARTWORK_SCAN_RESULT_GRACE_MS);
    });

    return () => {
      isMountedRef.current = false;
      activeScanRef.current = null;
      introTokenRef.current = null;
      if (introTimerRef.current) {
        clearTimeout(introTimerRef.current);
        introTimerRef.current = null;
      }
      clearGraceTimer();
      subscription.remove();
    };
  }, []);

  const pageLimit = Math.max(0, Math.min(Math.floor(remainingSlots), MAX_MEMORY_MEDIA_ASSETS));
  const pageLimitRef = useRef(pageLimit);
  useEffect(() => {
    pageLimitRef.current = pageLimit;
  });

  const releaseGuard = (token: number) => {
    if (activeScanRef.current === token) {
      activeScanRef.current = null;
    }
  };

  // Permission pre-check + scanner + result handling. Owns `token`: releases
  // the re-entry guard when it finishes.
  const runScan = async (token: number) => {
    const scanPageLimit = pageLimitRef.current;
    try {
      if (Platform.OS === 'ios') {
        // VisionKit shows a dead camera without permission, so ask first,
        // with the same Settings copy as the media picker's camera path.
        const { permission, didRequest } = await getOrRequestNativePermission(
          () => ImagePicker.getCameraPermissionsAsync(),
          () => ImagePicker.requestCameraPermissionsAsync(),
        );
        if (!permission.granted) {
          onErrorRef.current(
            permission.canAskAgain === false
              ? 'Camera permission is required to scan artwork. Enable it in Settings.'
              : 'Camera permission is required to scan artwork.',
          );
          return;
        }
        if (didRequest) {
          await waitForNativePresentationToSettle();
        }
        // No page-limit API on iOS: state the cap before the scanner opens.
        onNoticeRef.current?.(describeScanCap(scanPageLimit));
      }

      let result;
      try {
        result = await scanArtwork({ remainingSlots: scanPageLimit });
      } catch (error) {
        trackEvent('artwork_scan_result', { status: 'error', page_count: 0 });
        onNoticeRef.current?.('');
        if (isMountedRef.current) {
          onErrorRef.current(describeScanError(error));
        }
        return;
      }

      if (!isMountedRef.current) {
        // The composer went away while the scanner was open: nobody can
        // take ownership of the pages, so don't leave them on disk.
        await Promise.all(result.attachments.map((attachment) => deleteArtworkScanFile(attachment.uri)));
        return;
      }

      if (result.status !== 'success') {
        trackEvent('artwork_scan_result', { status: 'cancel', page_count: 0 });
        // Leave the iOS cap hint up after a cancel; nothing changed.
        return;
      }

      trackEvent('artwork_scan_result', { status: 'success', page_count: result.attachments.length });

      // Notice first, then the pages: the parent may refuse the pages (the
      // composer changed while the scanner was open) and replace the notice
      // with its own explanation from inside onScanned.
      onNoticeRef.current?.(
        describeScanOutcome({
          droppedCount: result.droppedCount,
          rejectedCount: result.rejectedCount,
          validationError: result.validationError,
        }),
      );
      if (result.attachments.length > 0) {
        onScannedRef.current(result.attachments);
      } else if (result.rejectedCount > 0) {
        onErrorRef.current(result.validationError ?? "Couldn't add those pages. Please try again.");
      }
    } catch {
      // Permission lookup or callback plumbing failed -- never leave the
      // button wedged or surface a raw error.
      if (isMountedRef.current) {
        onErrorRef.current("Couldn't open the scanner. Please try again.");
      }
    } finally {
      releaseGuard(token);
    }
  };

  const handlePress = async () => {
    if (activeScanRef.current !== null) {
      return;
    }
    const token = nextScanTokenRef.current;
    nextScanTokenRef.current += 1;
    activeScanRef.current = token;

    let handedOff = false;
    try {
      onErrorRef.current('');

      if (pageLimit <= 0) {
        onErrorRef.current(`A memory holds up to ${MAX_MEMORY_MEDIA_ASSETS} pieces of artwork.`);
        return;
      }

      // First tap on this device: show the intro instead of scanning. The
      // guard stays held until the sheet resolves (see handleIntroDismissed).
      if (!(await readIntroSeen())) {
        await writeIntroSeen();
        if (!isMountedRef.current) {
          return;
        }
        introTokenRef.current = token;
        introStartRequestedRef.current = false;
        setIntroMounted(true);
        setIntroVisible(true);
        handedOff = true;
        return;
      }

      handedOff = true;
      await runScan(token);
    } catch {
      if (isMountedRef.current) {
        onErrorRef.current("Couldn't open the scanner. Please try again.");
      }
    } finally {
      if (!handedOff) {
        releaseGuard(token);
      }
    }
  };

  const clearIntroTimer = () => {
    if (introTimerRef.current) {
      clearTimeout(introTimerRef.current);
      introTimerRef.current = null;
    }
  };

  // The intro Modal has fully dismissed (iOS `onDismiss`; Android right after
  // `visible` flips). Only now may the scanner open: iOS won't present
  // VisionKit over a Modal that is still dismissing. Idempotent -- the
  // fallback timer and the real callback can both land.
  const handleIntroDismissed = () => {
    clearIntroTimer();
    const token = introTokenRef.current;
    if (token === null) {
      return;
    }
    introTokenRef.current = null;
    if (introStartRequestedRef.current && isMountedRef.current) {
      introStartRequestedRef.current = false;
      void runScan(token);
      return;
    }
    introStartRequestedRef.current = false;
    releaseGuard(token);
  };

  const handleIntroStart = () => {
    if (introStartRequestedRef.current) {
      return;
    }
    introStartRequestedRef.current = true;
    setIntroVisible(false);
    clearIntroTimer();
    introTimerRef.current = setTimeout(handleIntroDismissed, ARTWORK_INTRO_DISMISS_TIMEOUT_MS);
  };

  const handleIntroClose = () => {
    // Already closing for "Start scanning": a stray backdrop tap mid-dismiss
    // must not cancel the scan.
    if (introStartRequestedRef.current) {
      return;
    }
    setIntroVisible(false);
  };

  // No deps: re-bound each render so the handle sees the latest props.
  useImperativeHandle(ref, () => ({
    startScan: () => {
      if (disabled || !isArtworkScannerAvailable()) return;
      void handlePress();
    },
  }));

  if (!isArtworkScannerAvailable()) {
    return null;
  }

  return (
    <>
      <Pressable
        accessibilityHint={`Scans up to ${pageLimit} ${pageLimit === 1 ? 'piece' : 'pieces'} of artwork`}
        accessibilityLabel="Scan artwork"
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          void handlePress();
        }}
        style={({ pressed }) => [
          styles.compactBtn,
          disabled && styles.compactBtnDisabled,
          pressed && !disabled && styles.compactBtnPressed,
        ]}
        testID={testID}
      >
        <ScanArtIcon disabled={disabled} />
      </Pressable>
      {introMounted ? (
        <ArtworkIntroSheet
          onClose={handleIntroClose}
          onDismissed={handleIntroDismissed}
          onStart={handleIntroStart}
          testID={`${testID}-intro`}
          visible={introVisible}
        />
      ) : null}
    </>
  );
});

/** One-line inline note for `ArtworkScanButton`'s `onNotice` text. Neutral
 * (not error red) -- these are hints and "some pages left out" facts. */
export function ArtworkScanNotice({ message, testID }: { message: string; testID?: string }) {
  if (!message) {
    return null;
  }
  return (
    <Text accessibilityLiveRegion="polite" style={styles.notice} testID={testID}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  compactBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactBtnDisabled: {
    opacity: 0.4,
  },
  compactBtnPressed: {
    opacity: 0.7,
  },
  notice: {
    fontFamily: fonts.sans,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.ink3,
  },
});
