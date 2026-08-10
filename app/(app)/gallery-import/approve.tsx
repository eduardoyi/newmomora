import { useLocalSearchParams } from 'expo-router';

import { GalleryImportApproval } from '@/components/gallery-import/gallery-import-flow';

export default function GalleryImportApprovalRoute() {
  const { runId, candidateId } = useLocalSearchParams<{ runId?: string; candidateId?: string }>();
  return <GalleryImportApproval candidateId={candidateId} runId={runId} />;
}
