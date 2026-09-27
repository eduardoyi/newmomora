import { dispatchGalleryImportChunk, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleDispatchGalleryImportChunk = withGalleryImportRequest(dispatchGalleryImportChunk);
if (import.meta.main) serveWithSentry('dispatch-gallery-import-chunk', handleDispatchGalleryImportChunk);
