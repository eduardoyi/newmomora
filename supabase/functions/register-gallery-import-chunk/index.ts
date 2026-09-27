import { registerGalleryImportChunk, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleRegisterGalleryImportChunk = withGalleryImportRequest(registerGalleryImportChunk);
if (import.meta.main) serveWithSentry('register-gallery-import-chunk', handleRegisterGalleryImportChunk);
