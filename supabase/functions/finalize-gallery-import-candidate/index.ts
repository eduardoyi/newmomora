import { finalizeGalleryImportCandidate, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleFinalizeGalleryImportCandidate = withGalleryImportRequest(finalizeGalleryImportCandidate);
if (import.meta.main) serveWithSentry('finalize-gallery-import-candidate', handleFinalizeGalleryImportCandidate);
