import { createGalleryImportRun, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';

export const handleCreateGalleryImportRun = withGalleryImportRequest(createGalleryImportRun);
if (import.meta.main) serveWithSentry('create-gallery-import-run', handleCreateGalleryImportRun);
