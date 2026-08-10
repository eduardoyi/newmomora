import { getGalleryImportUploadUrl, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleGetGalleryImportUploadUrl = withGalleryImportRequest(getGalleryImportUploadUrl);
if (import.meta.main) Deno.serve(handleGetGalleryImportUploadUrl);
