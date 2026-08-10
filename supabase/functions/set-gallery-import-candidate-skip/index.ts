import { setGalleryImportCandidateSkip, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleSetGalleryImportCandidateSkip = withGalleryImportRequest(setGalleryImportCandidateSkip);
if (import.meta.main) Deno.serve(handleSetGalleryImportCandidateSkip);
