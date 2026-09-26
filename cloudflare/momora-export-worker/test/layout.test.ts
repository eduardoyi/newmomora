import { describe, expect, it } from 'vitest';

import { fileExtension, memoryFolderName, memoryMediaFileNames, renderMemoryText, sanitizeSegment, uniqueName } from '../src/layout';
import type { ExportMemory } from '../src/types';

function memory(overrides: Partial<ExportMemory> = {}): ExportMemory {
  return {
    id: 'm1', family_id: 'f1', user_id: 'u1', memory_type: 'text_only', content: null, audio_transcript: null,
    link_previews: null, memory_date: '2026-09-09', emotion: null, illustration_key: null, illustration_status: 'none',
    media_key: null, media_content_type: null, created_at: '2026-09-09T10:00:00Z', ...overrides,
  };
}

describe('layout', () => {
  it('makes path segments safe on every desktop OS', () => {
    expect(sanitizeSegment('Enzo: "the/best" day?  ', 'x')).toBe('Enzo the best day');
    expect(sanitizeSegment('ends with dots...', 'x')).toBe('ends with dots');
    expect(sanitizeSegment('CON', 'x')).toBe('CON_');
    expect(sanitizeSegment('   ', 'Fallback')).toBe('Fallback');
    expect(sanitizeSegment('a'.repeat(80), 'x').length).toBeLessThanOrEqual(60);
  });

  it('names a memory folder by date and first words, falling back by type', () => {
    expect(memoryFolderName(memory({ content: 'Enzo le puso el parche en el ojo a Mara\ncon mucho cariño' })))
      .toBe('2026-09-09 - Enzo le puso el parche en el ojo a Mara');
    expect(memoryFolderName(memory({ memory_type: 'audio', audio_transcript: 'Enzo ven a lavarte los dientes' })))
      .toBe('2026-09-09 - Enzo ven a lavarte los dientes');
    expect(memoryFolderName(memory({ memory_type: 'audio' }))).toBe('2026-09-09 - Voice memory');
    expect(memoryFolderName(memory({ memory_type: 'media', media_content_type: 'video/mp4' }))).toBe('2026-09-09 - Video');
    expect(memoryFolderName(memory({ content: 'https://example.com/only-a-link' }))).toBe('2026-09-09 - Memory');
  });

  it('dedupes names case-insensitively', () => {
    const used = new Set<string>();
    expect(uniqueName('2026-09-09 - Beach', used)).toBe('2026-09-09 - Beach');
    expect(uniqueName('2026-09-09 - beach', used)).toBe('2026-09-09 - beach (2)');
  });

  it('names media by type and position, and audio as voice', () => {
    expect(memoryMediaFileNames([{ objectKey: 'u/m/a.jpg', contentType: 'image/jpeg' }])).toEqual(['photo.jpg']);
    expect(memoryMediaFileNames([
      { objectKey: 'u/m/a.heic', contentType: 'image/heic' },
      { objectKey: 'u/m/b.mp4', contentType: 'video/mp4' },
      { objectKey: 'u/m/c', contentType: 'image/png' },
    ])).toEqual(['photo-1.heic', 'video-2.mp4', 'photo-3.png']);
    expect(memoryMediaFileNames([{ objectKey: 'u/m/clip.m4a', contentType: 'audio/mp4' }])).toEqual(['voice.m4a']);
    expect(fileExtension('u/m/noext', 'video/quicktime')).toBe('mov');
  });

  it('renders memory.txt with the words, people, transcript, links and comments', () => {
    const text = renderMemoryText(memory({
      memory_type: 'audio',
      content: 'Bedtime',
      audio_transcript: 'Enzo ven a lavarte los dientes',
      emotion: 'funny',
      link_previews: [{ url: 'https://example.com/song' }],
    }), {
      postedBy: 'Adrianita',
      taggedNames: ['Enzo', 'Mara'],
      comments: [{ authorName: 'Tita', created_at: '2026-09-10T08:00:00Z', content: 'Jajaja' }],
    });
    expect(text).toBe([
      '2026-09-09', 'Added by Adrianita', 'With Enzo, Mara', 'Feeling: funny', '', 'Bedtime', '',
      'What was said:', 'Enzo ven a lavarte los dientes', '', 'Links:', '- https://example.com/song', '',
      'Comments:', '- Tita (2026-09-10): Jajaja', '',
    ].join('\r\n'));
  });
});
