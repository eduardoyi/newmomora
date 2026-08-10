import { getGalleryImportRun, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleGetGalleryImportRun = withGalleryImportRequest(getGalleryImportRun);
if (import.meta.main) Deno.serve(handleGetGalleryImportRun);
