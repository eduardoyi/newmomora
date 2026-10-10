import { Image } from 'expo-image';
import { memo, useMemo } from 'react';
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

interface ArtworkPieceImageProps {
  url: string | undefined;
  objectKey: string | null;
  onError?: () => void;
  testID?: string;
}

/** The scan inside a frame's opening. `contain` so a scan is never cropped;
 * the frame opening is already sized to the piece's aspect ratio. Until the
 * URL arrives the opening shows the frame's white paper backdrop. */
export const ArtworkPieceImage = memo(function ArtworkPieceImage({
  url,
  objectKey,
  onError,
  testID,
}: ArtworkPieceImageProps) {
  if (!url) return null;
  return (
    <Image
      contentFit="contain"
      onError={onError}
      source={mediaImageSource(url, objectKey)}
      style={StyleSheet.absoluteFill}
      testID={testID}
    />
  );
});
