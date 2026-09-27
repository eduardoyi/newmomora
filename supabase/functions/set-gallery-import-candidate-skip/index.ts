import { setGalleryImportCandidateSkip, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleSetGalleryImportCandidateSkip = withGalleryImportRequest(setGalleryImportCandidateSkip);
if (import.meta.main) serveWithSentry('set-gallery-import-candidate-skip', handleSetGalleryImportCandidateSkip);
