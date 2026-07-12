import { StyleSheet, View } from 'react-native';

import { PendingMemoryUploadCard } from '@/components/pending-memory-upload-card';
import { spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';

// Stack of in-flight/failed memory posts, rendered above the feed on the
// timeline and calendar tabs. Scoped to the active family (a post enqueued
// for family A shouldn't sit above family B's feed); renders nothing when
// the queue has no entries for it.
export function PendingMemoryUploadsBanner() {
  const { familyId } = useFamily();
  const { uploads: allUploads, retry, discard } = usePendingMemoryUploads();
  const uploads = allUploads.filter((upload) => upload.familyId === familyId);

  if (uploads.length === 0) {
    return null;
  }

  return (
    <View style={styles.container} testID="pending-memory-uploads-banner">
      {uploads.map((upload) => (
        <PendingMemoryUploadCard
          key={upload.memoryId}
          upload={upload}
          onRetry={() => retry(upload.memoryId)}
          onDiscard={() => discard(upload.memoryId)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
});
