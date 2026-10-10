// Compact toolbar button that launches the native document scanner for
// artwork (docs/plans/artwork-scanning.md, 3.3). Sits beside the mic and
// `MemoryMediaPicker` in the composer toolbar and mirrors the picker's
// compact style, disabled styling, and "report failures to the parent, which
// renders them inline" contract.
//
// Hidden entirely when `isArtworkScannerAvailable()` is false (OTA bundles
// reaching binaries built before the native module existed).
import * as ImagePicker from 'expo-image-picker';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text } from 'react-native';

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

export function ArtworkScanButton({
  onScanned,
  onError,
  onNotice,
  disabled = false,
  remainingSlots = MAX_MEMORY_MEDIA_ASSETS,
  testID = 'new-memory-scan-artwork',
}: ArtworkScanButtonProps) {
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
      clearGraceTimer();
      subscription.remove();
    };
  }, []);

  if (!isArtworkScannerAvailable()) {
    return null;
  }

  const pageLimit = Math.max(0, Math.min(Math.floor(remainingSlots), MAX_MEMORY_MEDIA_ASSETS));

  const handlePress = async () => {
    if (activeScanRef.current !== null) {
      return;
    }
    const token = nextScanTokenRef.current;
    nextScanTokenRef.current += 1;
    activeScanRef.current = token;

    try {
      onErrorRef.current('');

      if (pageLimit <= 0) {
        onErrorRef.current(`A memory holds up to ${MAX_MEMORY_MEDIA_ASSETS} pieces of artwork.`);
        return;
      }

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
        onNoticeRef.current?.(describeScanCap(pageLimit));
      }

      let result;
      try {
        result = await scanArtwork({ remainingSlots: pageLimit });
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
      if (activeScanRef.current === token) {
        activeScanRef.current = null;
      }
    }
  };

  return (
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
      <SymbolView
        name={{ ios: 'doc.viewfinder', android: 'document_scanner' }}
        size={20}
        tintColor={colors.ink2}
        fallback={<Text style={styles.compactBtnIcon}>▣</Text>}
      />
    </Pressable>
  );
}

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
  compactBtnIcon: {
    fontSize: 20,
    color: colors.ink2,
  },
  notice: {
    fontFamily: fonts.sans,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.ink3,
  },
});
