// Mounts the single app-root gallery-import driver (S10,
// docs/plans/gallery-import-continuous.md). This hook owns no visible UI and
// returns nothing -- it exists purely to wire the module-singleton driver
// (src/services/gallery-import-driver.ts) to the current user/family and to
// real app-lifecycle listeners exactly once per app session. Mount it in
// app/(app)/_layout.tsx only; every screen that wants to react to the
// driver's progress uses `subscribeGalleryImportDriver`/`kickGalleryImportDriver`
// directly (or through `useGalleryImportEntryStatus`), never this hook.
import { useEffect } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  kickGalleryImportDriver,
  setGalleryImportDriverContext,
  startGalleryImportDriverListeners,
} from '@/services/gallery-import-driver';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';

export function useGalleryImportDriver(): void {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const userId = user?.id ?? null;

  useEffect(() => {
    // The AppState/NetInfo listeners are process-lifetime and idempotent to
    // register -- start them once regardless of auth/family state so a later
    // sign-in doesn't need its own separate wiring step.
    startGalleryImportDriverListeners();
  }, []);

  useEffect(() => {
    if (!isGalleryImportFeatureEnabled) return;
    setGalleryImportDriverContext(userId, familyId ?? null);
    if (userId && familyId) kickGalleryImportDriver('mount-or-family-change');
  }, [userId, familyId]);
}
