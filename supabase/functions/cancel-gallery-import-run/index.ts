import { cancelGalleryImportRun, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleCancelGalleryImportRun = withGalleryImportRequest(cancelGalleryImportRun);
if (import.meta.main) serveWithSentry('cancel-gallery-import-run', handleCancelGalleryImportRun);
