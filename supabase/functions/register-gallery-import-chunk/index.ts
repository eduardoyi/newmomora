import { registerGalleryImportChunk, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleRegisterGalleryImportChunk = withGalleryImportRequest(registerGalleryImportChunk);
if (import.meta.main) Deno.serve(handleRegisterGalleryImportChunk);
