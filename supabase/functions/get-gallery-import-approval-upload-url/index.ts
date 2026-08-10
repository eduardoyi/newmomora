import { getGalleryImportApprovalUploadUrl, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleGetGalleryImportApprovalUploadUrl = withGalleryImportRequest(getGalleryImportApprovalUploadUrl);
if (import.meta.main) Deno.serve(handleGetGalleryImportApprovalUploadUrl);
