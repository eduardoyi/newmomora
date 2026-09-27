import { getGalleryImportCandidates, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleGetGalleryImportCandidates = withGalleryImportRequest(getGalleryImportCandidates);
if (import.meta.main) serveWithSentry('get-gallery-import-candidates', handleGetGalleryImportCandidates);
