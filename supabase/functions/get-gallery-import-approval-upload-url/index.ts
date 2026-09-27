import { getGalleryImportApprovalUploadUrl, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleGetGalleryImportApprovalUploadUrl = withGalleryImportRequest(getGalleryImportApprovalUploadUrl);
if (import.meta.main) serveWithSentry('get-gallery-import-approval-upload-url', handleGetGalleryImportApprovalUploadUrl);
