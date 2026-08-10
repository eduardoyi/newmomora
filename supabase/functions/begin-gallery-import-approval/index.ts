import { beginGalleryImportApproval, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleBeginGalleryImportApproval = withGalleryImportRequest(beginGalleryImportApproval);
if (import.meta.main) Deno.serve(handleBeginGalleryImportApproval);
