import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { familyMembershipsQueryKeyBase } from '@/hooks/queryKeys';
import { useIsOnline } from '@/lib/connectivity';
import { composeShareCard, type ShareCardServiceError } from '@/services/share-card';
import { bytesToBase64 } from '@/utils/base64';
import { buildShareCardTempFilename } from '@/utils/share-card-filename';

export interface ShareableMemory {
  id: string;
  memory_date: string;
}

export interface UseShareMemoryCardResult {
  shareMemoryCard: (memory: ShareableMemory, mediaAssetId?: string | null) => Promise<void>;
  /** True while THIS hook instance's own share is in flight. Each
   * `MemoryEngagementBar` calls this hook itself, so state is naturally
   * scoped to that one card -- no memory-id bookkeeping needed here. */
  isSharing: boolean;
}

const SHARING_OFF_FALLBACK_MESSAGE = 'Sharing is currently off for this family';

// Pulled from queryKeys.ts (dependency-free) rather than importing
// use-family.tsx's `familyMembershipsQueryKey` directly -- same reasoning as
// src/lib/query-persistence.ts's own comment: this hook shouldn't drag in
// use-family.tsx's heavy transitive chain (use-auth -> lib/supabase's
// realtime client, etc.) just to build one query key. Matches the exact key
// shape `[familyMembershipsQueryKeyBase] as const` used there.
const familyMembershipsInvalidationKey = [familyMembershipsQueryKeyBase] as const;

/**
 * Maps a share-card service error onto the S4-specced UX (see
 * docs/plans/offline-awareness-and-share-cards.md S4). Exported for direct
 * unit testing.
 *
 * - Offline (or a network-level fetch failure): O's "you're offline" framing.
 * - 403 (family sharing toggled off): the server's own message AND
 *   invalidates the family-membership query -- the viewer's cached
 *   `viewerSharingEnabled` can be up to 7 days stale (O4's persist `maxAge`),
 *   so the icon must actually disappear next render, not just this attempt
 *   fail.
 * - 429: a friendly rate-limit message, no invalidation.
 * - Everything else: a generic non-blocking error.
 */
export function handleShareCardError(
  error: ShareCardServiceError,
  isOnline: boolean,
  queryClient: QueryClient,
): void {
  if (!isOnline || error.code === 'network_error') {
    Alert.alert("You're offline", 'Connect to the internet to share this memory.');
    return;
  }

  if (error.status === 403) {
    Alert.alert('Sharing is off', error.message || SHARING_OFF_FALLBACK_MESSAGE);
    void queryClient.invalidateQueries({ queryKey: familyMembershipsInvalidationKey });
    return;
  }

  if (error.status === 429) {
    Alert.alert("You're sharing a lot", 'Please wait a moment and try again.');
    return;
  }

  // A memory type this build offered the share icon for but the server
  // rejects (e.g. `audio`, before an old installed client has updated --
  // P0.1, docs/plans/audio-memories-v1.md). The server's own message is
  // written for this exact case ("Audio memories cannot be shared yet");
  // surface it instead of the generic fallback below.
  if (error.code === 'unsupported_memory_type') {
    Alert.alert('Could not share memory', error.message || 'This memory can’t be shared yet.');
    return;
  }

  Alert.alert('Could not share memory', 'Please try again.');
}

/**
 * Orchestrates the S4 tap flow: compose the PNG via `composeShareCard`
 * (which owns the 546-retry), write it to a uniquely-named temp file under
 * `cacheDirectory`, hand it to the native share sheet, then best-effort
 * delete the temp file. Extracted out of `MemoryEngagementBar` so the flow
 * is unit-testable without mounting the icon UI.
 */
export function useShareMemoryCard(): UseShareMemoryCardResult {
  const [isSharing, setIsSharing] = useState(false);
  const isOnline = useIsOnline();
  const queryClient = useQueryClient();

  const shareMemoryCard = useCallback(
    async (memory: ShareableMemory, mediaAssetId?: string | null) => {
      if (isSharing) {
        return;
      }

      setIsSharing(true);
      let fileUri: string | null = null;

      try {
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
          Alert.alert('Sharing unavailable', 'Sharing is not available on this device.');
          return;
        }

        const result = await composeShareCard({
          memoryId: memory.id,
          mediaAssetId: mediaAssetId ?? undefined,
        });

        if (!result.ok) {
          handleShareCardError(result.error, isOnline, queryClient);
          return;
        }

        const base64 = bytesToBase64(new Uint8Array(result.bytes));
        const filename = buildShareCardTempFilename(memory.memory_date, memory.id);
        fileUri = `${FileSystem.cacheDirectory ?? ''}${filename}`;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await Sharing.shareAsync(fileUri, { mimeType: 'image/png' });
      } catch {
        Alert.alert('Could not share memory', 'Please try again.');
      } finally {
        if (fileUri) {
          // Best-effort -- cacheDirectory is OS-managed anyway.
          await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => undefined);
        }
        setIsSharing(false);
      }
    },
    [isSharing, isOnline, queryClient],
  );

  return { shareMemoryCard, isSharing };
}
