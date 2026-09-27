import { getGalleryCaptionSettings, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleGetGalleryCaptionSettings = withGalleryImportRequest(getGalleryCaptionSettings);
if (import.meta.main) serveWithSentry('get-gallery-caption-settings', handleGetGalleryCaptionSettings);
