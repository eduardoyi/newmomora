import type { ComponentType } from 'react';
import type { TemplateId } from '../model/types';
import type { TemplateProps } from './types';
import { FlexGrid } from './FlexGrid';
import { PhotoStory } from './PhotoStory';
import { IllustratedStory } from './IllustratedStory';
import { TextPage } from './TextPage';
import { FullBleed } from './FullBleed';
import { PanoramaSpread } from './PanoramaSpread';
import { ThroughTheYears } from './ThroughTheYears';
import { SpreadTitle } from './SpreadTitle';
import { AnchorMedia } from './AnchorMedia';
import { AudioNote } from './AudioNote';
import { Firsts } from './Firsts';
import { WraparoundCover } from './WraparoundCover';
import { Dedication } from './Dedication';
import { Blank } from './Blank';
import { Closing } from './Closing';
import { QuoteCollection } from './QuoteCollection';
import { IllustratedDigest } from './IllustratedDigest';

export const TEMPLATE_REGISTRY: Record<TemplateId, ComponentType<TemplateProps>> = {
  'flex-grid': FlexGrid,
  'photo-story': PhotoStory,
  'illustrated-story': IllustratedStory,
  'text-page': TextPage,
  'full-bleed': FullBleed,
  'panorama-spread': PanoramaSpread,
  'through-the-years': ThroughTheYears,
  'spread-title': SpreadTitle,
  'anchor-media': AnchorMedia,
  'audio-note': AudioNote,
  firsts: Firsts,
  'cover-wrap': WraparoundCover,
  dedication: Dedication,
  blank: Blank,
  closing: Closing,
  'quote-collection': QuoteCollection,
  // Round-12: promoted from a preview-demo-only composition to a real
  // fitter-emitted one (see fitter.ts's digest-sweep chunking) — the
  // preview's "Digest demo" toggle still renders it too, via the same
  // slot-building path (src/preview/digestDemo.ts).
  'illustrated-digest': IllustratedDigest,
};

export function TemplateRenderer(props: TemplateProps) {
  const Component = TEMPLATE_REGISTRY[props.page.templateId];
  return <Component {...props} />;
}

export * from './types';
