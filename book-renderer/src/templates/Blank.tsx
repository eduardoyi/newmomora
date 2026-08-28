import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';

/**
 * The deliberately blank even page facing the dedication (Momora Book
 * Layout System 1a "dedicatoria": "página par vacía a propósito"). No
 * folio is printed on it either — see Dedication/Folio.
 */
export function Blank({ showGuides }: TemplateProps) {
  return <PageFrame isSpread={false} showGuides={showGuides} className="blank-page" />;
}
