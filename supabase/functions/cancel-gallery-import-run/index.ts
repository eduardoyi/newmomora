import { cancelGalleryImportRun, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleCancelGalleryImportRun = withGalleryImportRequest(cancelGalleryImportRun);
if (import.meta.main) Deno.serve(handleCancelGalleryImportRun);
