import { updateGalleryCaptionSettings, withGalleryImportRequest } from '../_shared/gallery-import.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
export const handleUpdateGalleryCaptionSettings = withGalleryImportRequest(updateGalleryCaptionSettings);
if (import.meta.main) serveWithSentry('update-gallery-caption-settings', handleUpdateGalleryCaptionSettings);
