import { recordGalleryImportApprovalUpload, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleRecordGalleryImportApprovalUpload = withGalleryImportRequest(recordGalleryImportApprovalUpload);
if (import.meta.main) Deno.serve(handleRecordGalleryImportApprovalUpload);
