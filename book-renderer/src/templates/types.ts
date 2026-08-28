import type { BookManifest, BookPage } from '../model/types';

/** Shared props every template component receives from the preview pager. */
export interface TemplateProps {
  page: BookPage;
  manifest: BookManifest;
  bookSlug: string;
  showGuides: boolean;
}
