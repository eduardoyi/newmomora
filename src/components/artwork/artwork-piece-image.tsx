import { Image } from 'expo-image';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';

import type { ArtworkPiece } from '@/components/artwork/artwork-pieces';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { mediaImageSource } from '@/utils/media-image-source';

/** Signed URLs for every piece of a memory in ONE request, keyed by the
 * piece's display key. `refetch` is for an expired URL (image error). */
export function useArtworkPieceUrls(pieces: readonly ArtworkPiece[], cacheVersion?: string | null) {
  const keys = useMemo(
    () => pieces.map((piece) => piece.displayKey).filter((key): key is string => Boolean(key)),
    [pieces],
  );
  const { data, refetch } = useMediaUrls(keys, cacheVersion);
  return { urls: data ?? EMPTY_URLS, refetch };
}

const EMPTY_URLS: Record<string, string> = {};

/** What an image reports when its signed URL failed / loaded: the object key
 * of the piece (never logged; only used to bound recovery per piece). */
export type ArtworkUrlErrorHandler = (objectKey: string | null) => void;

/**
 * Image-error recovery for signed URLs, bounded. An image error usually means
 * the signed URL expired, so one `refetch` re-signs; but if the new URL fails
 * too (R2 or the network is down) a refetch per failure would loop forever --
 * error -> re-sign -> new URL -> error -> ... So each object key gets ONE
 * recovery attempt until one of its images actually loads (`onLoad` hands the
 * budget back, so a genuine expiry much later still recovers). Concurrent
 * failures from several pieces share one request (`cancelRefetch: false`
 * joins the in-flight fetch instead of cancelling and restarting it). Nothing
 * is logged: a transient network failure is expected, not an error.
 */
export function useArtworkUrlRecovery(refetch: () => unknown): {
  onError: ArtworkUrlErrorHandler;
  onLoad: ArtworkUrlErrorHandler;
} {
  const attempted = useRef(new Set<string>());
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);
  const onError = useCallback<ArtworkUrlErrorHandler>((objectKey) => {
    const budgetKey = objectKey ?? '';
    if (attempted.current.has(budgetKey)) return;
    attempted.current.add(budgetKey);
    try {
      const result = (refetchRef.current as (options?: { cancelRefetch: boolean }) => unknown)({
        cancelRefetch: false,
      });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // A failed recovery is not worth surfacing: the image keeps its frame.
    }
  }, []);
  const onLoad = useCallback<ArtworkUrlErrorHandler>((objectKey) => {
    attempted.current.delete(objectKey ?? '');
  }, []);
  return { onError, onLoad };
}

interface ArtworkPieceImageProps {
  url: string | undefined;
  objectKey: string | null;
  onError?: ArtworkUrlErrorHandler;
  onLoad?: ArtworkUrlErrorHandler;
  testID?: string;
}

/** The scan inside a frame's opening. `contain` so a scan is never cropped;
 * the frame opening is already sized to the piece's aspect ratio. Until the
 * URL arrives the opening shows the frame's white paper backdrop. */
export const ArtworkPieceImage = memo(function ArtworkPieceImage({
  url,
  objectKey,
  onError,
  onLoad,
  testID,
}: ArtworkPieceImageProps) {
  if (!url) return null;
  return (
    <Image
      contentFit="contain"
      onError={onError ? () => onError(objectKey) : undefined}
      onLoad={onLoad ? () => onLoad(objectKey) : undefined}
      source={mediaImageSource(url, objectKey)}
      style={StyleSheet.absoluteFill}
      testID={testID}
    />
  );
});
