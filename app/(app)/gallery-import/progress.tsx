import { useLocalSearchParams } from 'expo-router';

import { GalleryImportProgress } from '@/components/gallery-import/gallery-import-flow';

export default function GalleryImportProgressRoute() {
  const { runId } = useLocalSearchParams<{ runId?: string }>();
  return <GalleryImportProgress runId={runId} />;
}
