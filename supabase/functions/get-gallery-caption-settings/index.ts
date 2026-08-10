import { getGalleryCaptionSettings, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleGetGalleryCaptionSettings = withGalleryImportRequest(getGalleryCaptionSettings);
if (import.meta.main) Deno.serve(handleGetGalleryCaptionSettings);
