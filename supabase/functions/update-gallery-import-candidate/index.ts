import { updateGalleryImportCandidate, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleUpdateGalleryImportCandidate = withGalleryImportRequest(updateGalleryImportCandidate);
if (import.meta.main) Deno.serve(handleUpdateGalleryImportCandidate);
