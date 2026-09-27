import { getGalleryImportUploadUrl, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleGetGalleryImportUploadUrl = withGalleryImportRequest(getGalleryImportUploadUrl);
if (import.meta.main) serveWithSentry('get-gallery-import-upload-url', handleGetGalleryImportUploadUrl);
