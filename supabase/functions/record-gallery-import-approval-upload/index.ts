import { recordGalleryImportApprovalUpload, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleRecordGalleryImportApprovalUpload = withGalleryImportRequest(recordGalleryImportApprovalUpload);
if (import.meta.main) serveWithSentry('record-gallery-import-approval-upload', handleRecordGalleryImportApprovalUpload);
