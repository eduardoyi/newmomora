import { getGalleryImportRun, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleGetGalleryImportRun = withGalleryImportRequest(getGalleryImportRun);
if (import.meta.main) serveWithSentry('get-gallery-import-run', handleGetGalleryImportRun);
