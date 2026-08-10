import { createGalleryImportRun, withGalleryImportRequest } from '../_shared/gallery-import.ts';

export const handleCreateGalleryImportRun = withGalleryImportRequest(createGalleryImportRun);
if (import.meta.main) Deno.serve(handleCreateGalleryImportRun);
