import type { TemplateProps } from './types';
import { PageFrame } from './PageFrame';
import { SafeArea } from './common/SafeArea';
import { ScanMark } from './common/ScanMark';
import { SectionHeader, type SectionHeaderParams } from './common/SectionHeader';
import { formatLongDate } from './common/formatDate';
import { getFurniture, getLanguage } from './furniture';
import { ptCqw, canvasPxToPt } from './mm';
import { colors } from '../theme';
import type { AudioNoteContent, TextSlotContent } from '../model/types';
import './AudioNote.css';

/**
 * "Nota de voz" (Momora Book Layout System 1b §3 "audio-note"): the one
 * case where the scan mark IS the page image, not a credit line — without
 * it the memory doesn't exist on paper. The mark grows to 26mm, sits on the
 * optical axis, and the only handwritten word on the page is "escúchalo".
 * No duration, no metadata, no numbered footer index, and the transcription
 * is NEVER printed — the caption is the parent's own text, if any; the
 * voice itself is the content.
 */
export function AudioNote({ page, manifest, showGuides }: TemplateProps) {
  const notes = page.slots.filter(
    (s): s is { id: string; kind: 'audio-note'; content: AudioNoteContent } => s.kind === 'audio-note',
  );
  const lang = getLanguage(manifest);
  const furniture = getFurniture(lang);
  // A month segment made up entirely of audio memories otherwise has
  // nowhere to show its month header — same fix as illustrated-story (owner
  // review round 3, "headers vanished... photo-thin segments").
  const sectionHeader = (page.params.sectionHeader ?? null) as SectionHeaderParams | null;
  const textByMemory = new Map<string, string>();
  for (const s of page.slots) {
    if (s.kind === 'text') {
      const c = s.content as TextSlotContent;
      if (c.memoryId) textByMemory.set(c.memoryId, c.text);
    }
  }

  return (
    <PageFrame isSpread={false} showGuides={showGuides} className="audio-note-page">
      <SafeArea isSpread={false}>
        <div className="audio-note" data-testid="audio-note">
          {sectionHeader && <SectionHeader {...sectionHeader} isSpread={false} />}
          {notes.map((note, i) => (
            <div key={note.id} className={`audio-note__entry${i > 0 ? ' audio-note__entry--ruled' : ''}`}>
              {textByMemory.get(note.content.memoryId) && (
                <>
                  <span className="audio-note__date" style={{ fontSize: ptCqw(canvasPxToPt(9.5), false), color: colors.numeral }}>
                    {formatLongDate(note.content.date, lang)}
                  </span>
                  <p className="audio-note__caption" style={{ fontSize: ptCqw(canvasPxToPt(24), false), color: colors.ink }}>
                    {textByMemory.get(note.content.memoryId)}
                  </p>
                </>
              )}
              <div className="audio-note__mark">
                <ScanMark size="audio" isSpread={false} shareToken={note.content.shareToken} />
                <div className="audio-note__mark-text">
                  <span className="audio-note__word" style={{ fontSize: ptCqw(canvasPxToPt(34), false), color: colors.ink }}>
                    {furniture.listenToIt}
                  </span>
                  <span className="audio-note__code" style={{ fontSize: ptCqw(canvasPxToPt(10), false), color: colors.ink3 }}>
                    momora.co/e/{note.content.shortCode}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </SafeArea>
    </PageFrame>
  );
}
