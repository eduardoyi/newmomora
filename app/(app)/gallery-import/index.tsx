import { useLocalSearchParams } from 'expo-router';

import { GalleryImportEntry, type GalleryImportSurface } from '@/components/gallery-import/gallery-import-entry';

export default function GalleryImportEntryRoute() {
  const { surface } = useLocalSearchParams<{ surface?: GalleryImportSurface }>();
  return <GalleryImportEntry surface={surface} />;
}
