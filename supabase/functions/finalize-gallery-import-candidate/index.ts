import { finalizeGalleryImportCandidate, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleFinalizeGalleryImportCandidate = withGalleryImportRequest(finalizeGalleryImportCandidate);
if (import.meta.main) Deno.serve(handleFinalizeGalleryImportCandidate);
