import { completeGalleryImportRun, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleCompleteGalleryImportRun = withGalleryImportRequest(completeGalleryImportRun);
if (import.meta.main) Deno.serve(handleCompleteGalleryImportRun);
