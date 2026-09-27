import { completeGalleryImportRun, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleCompleteGalleryImportRun = withGalleryImportRequest(completeGalleryImportRun);
if (import.meta.main) serveWithSentry('complete-gallery-import-run', handleCompleteGalleryImportRun);
