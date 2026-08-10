import { dispatchGalleryImportChunk, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleDispatchGalleryImportChunk = withGalleryImportRequest(dispatchGalleryImportChunk);
if (import.meta.main) Deno.serve(handleDispatchGalleryImportChunk);
