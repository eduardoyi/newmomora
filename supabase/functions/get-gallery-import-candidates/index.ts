import { getGalleryImportCandidates, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleGetGalleryImportCandidates = withGalleryImportRequest(getGalleryImportCandidates);
if (import.meta.main) Deno.serve(handleGetGalleryImportCandidates);
