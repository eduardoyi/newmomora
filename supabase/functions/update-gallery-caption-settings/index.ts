import { updateGalleryCaptionSettings, withGalleryImportRequest } from '../_shared/gallery-import.ts';
export const handleUpdateGalleryCaptionSettings = withGalleryImportRequest(updateGalleryCaptionSettings);
if (import.meta.main) Deno.serve(handleUpdateGalleryCaptionSettings);
