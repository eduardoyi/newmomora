import { beginGalleryImportApproval, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleBeginGalleryImportApproval = withGalleryImportRequest(beginGalleryImportApproval);
if (import.meta.main) serveWithSentry('begin-gallery-import-approval', handleBeginGalleryImportApproval);
