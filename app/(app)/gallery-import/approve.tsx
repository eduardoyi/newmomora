import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';

import {
  GalleryImportApproval,
  type GalleryImportAddPhotosContext,
} from '@/components/gallery-import/gallery-import-approval';
import { GalleryImportPhotoChooser } from '@/components/gallery-import/gallery-import-review-sheets';
import { useRunCheckpoint } from '@/components/gallery-import/gallery-import-shared';
import { buildGalleryImportDayPool } from '@/utils/gallery-import-deck';

export default function GalleryImportApprovalRoute() {
  const { runId, candidateId, readyCount } = useLocalSearchParams<{ runId?: string; candidateId?: string; readyCount?: string }>();
  const { checkpoint } = useRunCheckpoint(runId);
  // The composer hands over its current selection when the parent should open
  // the day-pool chooser (the documented onAddPhotos seam); the sheet returns
  // an ordered selection through context.setPhotos.
  const [chooser, setChooser] = useState<GalleryImportAddPhotosContext | null>(null);
  const pool = useMemo(
    // The pool is keyed off the candidate's original selection: that is what
    // pins the server-side cluster the chooser may offer photos from.
    () => checkpoint && chooser ? buildGalleryImportDayPool(checkpoint, chooser.candidate.selectedAssetTokens) : [],
    [checkpoint, chooser],
  );
  // The deck passes its own already-known run.readyCandidates through the
  // route so this screen's initial "N left" reads real from the very first
  // frame -- GalleryImportApproval still refreshes it in the background
  // (see its own readyCount prop doc comment).
  const parsedReadyCount = readyCount !== undefined ? Number(readyCount) : undefined;
  return (
    <>
      <GalleryImportApproval
        candidateId={candidateId}
        onAddPhotos={setChooser}
        readyCount={Number.isFinite(parsedReadyCount) ? parsedReadyCount : undefined}
        runId={runId}
      />
      {chooser && checkpoint ? (
        <GalleryImportPhotoChooser
          candidate={chooser.candidate}
          initialSelected={chooser.selectedAssetTokens}
          mode="select"
          onClose={() => setChooser(null)}
          onUseSelection={chooser.setPhotos}
          pool={pool}
        />
      ) : null}
    </>
  );
}
