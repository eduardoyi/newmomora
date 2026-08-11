import { useLocalSearchParams } from 'expo-router';

import { GalleryImportReview } from '@/components/gallery-import/gallery-import-review';

export default function GalleryImportReviewRoute() {
  const { runId } = useLocalSearchParams<{ runId?: string }>();
  return <GalleryImportReview runId={runId} />;
}
