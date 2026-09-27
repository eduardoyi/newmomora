import { updateGalleryImportCandidate, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleUpdateGalleryImportCandidate = withGalleryImportRequest(updateGalleryImportCandidate);
if (import.meta.main) serveWithSentry('update-gallery-import-candidate', handleUpdateGalleryImportCandidate);
