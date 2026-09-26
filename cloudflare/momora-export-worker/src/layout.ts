// Human-readable archive layout. Everything a parent opens on a computer is
// named here; manifest.json keeps the structured, machine-readable view.
//
//   Momora - <Family>/
//     README.txt, manifest.json                       (Family & portraits archive)
//     Family/<Member>/profile-photo.jpg, portrait.webp
//     Family/<Member>/Portraits over time/<date> photo.jpg, <date> portrait.webp
//     <Year>/<YYYY-MM-DD> - <first words>/memory.txt, photo-1.jpg, video-2.mp4,
//                                         voice.m4a, illustration.webp
//
// Every archive shares the same top folder, so unzipping all of them side by
// side merges into one tree.

import type { ExportComment, ExportMemory } from './types';

const MAX_SEGMENT_LENGTH = 60;
const MAX_TITLE_LENGTH = 48;

/** Makes a single path segment safe on macOS, Windows and Linux. */
export function sanitizeSegment(value: string, fallback: string, maxLength = MAX_SEGMENT_LENGTH): string {
  let cleaned = value
    .normalize('NFC')
    // Path separators, Windows-reserved characters and control characters.
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > maxLength) {
    const cut = cleaned.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');
    cleaned = (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }
  // Windows rejects trailing dots/spaces and reserved device names.
  cleaned = cleaned.replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) cleaned = `${cleaned}_`;
  return cleaned || fallback;
}

/** Appends " (2)", " (3)"… until `name` is unused in `used` (case-insensitive). */
export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let counter = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${name} (${counter})`;
    counter += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function rootFolderName(familyName: string): string {
  return `Momora - ${sanitizeSegment(familyName, 'Family')}`;
}

export function archiveBaseName(familyName: string, label: string): string {
  return `Momora - ${sanitizeSegment(familyName, 'Family', 40)} - ${label}`;
}

export function memoryYear(memory: Pick<ExportMemory, 'memory_date'>): string {
  const year = /^(\d{4})/.exec(memory.memory_date)?.[1];
  return year ?? 'Undated';
}

function memoryTypeFallbackTitle(memory: ExportMemory): string {
  if (memory.memory_type === 'audio') return 'Voice memory';
  if (memory.memory_type === 'media') {
    return memory.media_content_type?.startsWith('video/') ? 'Video' : 'Photo';
  }
  return 'Memory';
}

export function memoryFolderName(memory: ExportMemory): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(memory.memory_date)?.[0] ?? 'Undated';
  const source = (memory.content?.trim() || memory.audio_transcript?.trim() || '')
    .replace(/https?:\/\/\S+/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  const title = sanitizeSegment(source, memoryTypeFallbackTitle(memory), MAX_TITLE_LENGTH);
  return `${date} - ${title}`;
}

/** Lower-case extension from the object key, else from the content type. */
export function fileExtension(objectKey: string, contentType: string | null): string {
  const fileName = objectKey.split('/').pop() ?? '';
  const dot = fileName.lastIndexOf('.');
  const fromKey = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  if (/^[a-z0-9]{1,5}$/.test(fromKey)) return fromKey;
  switch (contentType) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'video/mp4': return 'mp4';
    case 'video/quicktime': return 'mov';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a': return 'm4a';
    case 'audio/mpeg': return 'mp3';
    case 'audio/aac': return 'aac';
    default: return 'bin';
  }
}

export type MediaCategory = 'photo' | 'video' | 'audio' | 'file';

export function mediaCategory(contentType: string | null): MediaCategory {
  if (contentType?.startsWith('image/')) return 'photo';
  if (contentType?.startsWith('video/')) return 'video';
  if (contentType?.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * File names for a memory's media, in position order: a lone photo is
 * "photo.jpg"; several are "photo-1.jpg", "video-2.mp4"… (numbered by
 * position across all media so the original order survives); audio is
 * always "voice.m4a".
 */
export function memoryMediaFileNames(
  media: Array<{ objectKey: string; contentType: string | null }>,
): string[] {
  const numbered = media.length > 1;
  const used = new Set<string>();
  return media.map((item, index) => {
    const category = mediaCategory(item.contentType);
    const ext = fileExtension(item.objectKey, item.contentType);
    const stem = category === 'audio' ? 'voice' : numbered ? `${category}-${index + 1}` : category;
    return `${uniqueName(stem, used)}.${ext}`;
  });
}

function linkUrls(linkPreviews: unknown): string[] {
  const urls: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      const url = (value as { url?: unknown }).url;
      if (typeof url === 'string') urls.push(url);
      else Object.values(value).forEach(visit);
    }
  };
  visit(linkPreviews);
  return [...new Set(urls)];
}

export interface MemoryTextContext {
  postedBy: string | null;
  taggedNames: string[];
  comments: Array<Pick<ExportComment, 'content' | 'created_at'> & { authorName: string }>;
}

export function renderMemoryText(memory: ExportMemory, context: MemoryTextContext): string {
  const lines: string[] = [memory.memory_date.slice(0, 10)];
  if (context.postedBy) lines.push(`Added by ${context.postedBy}`);
  if (context.taggedNames.length > 0) lines.push(`With ${context.taggedNames.join(', ')}`);
  if (memory.emotion) lines.push(`Feeling: ${memory.emotion}`);

  const content = memory.content?.trim();
  if (content) lines.push('', content);

  const transcript = memory.audio_transcript?.trim();
  if (transcript && transcript !== content) lines.push('', 'What was said:', transcript);

  const urls = linkUrls(memory.link_previews);
  if (urls.length > 0) lines.push('', 'Links:', ...urls.map((url) => `- ${url}`));

  if (context.comments.length > 0) {
    lines.push('', 'Comments:');
    for (const comment of context.comments) {
      lines.push(`- ${comment.authorName} (${comment.created_at.slice(0, 10)}): ${comment.content.trim()}`);
    }
  }
  // CRLF so Notepad on older Windows shows line breaks too.
  return `${lines.join('\r\n')}\r\n`;
}

export function renderReadme(input: {
  familyName: string;
  exportedAt: string;
  archiveNames: string[];
  memoryCount: number;
}): string {
  const lines = [
    `Your Momora archive - ${input.familyName}`,
    `Exported ${input.exportedAt.slice(0, 10)}`,
    '',
    `This archive has ${input.memoryCount} ${input.memoryCount === 1 ? 'memory' : 'memories'}, split across these files:`,
    ...input.archiveNames.map((name) => `- ${name}`),
    '',
    'Unzip them all into the same place and they combine into one folder:',
    '',
    '  Family/                    Everyone\'s photos and illustrated portraits,',
    '                             including how their portraits changed over time.',
    '  2024/, 2025/, …            One folder per year, then one folder per memory',
    '                             named by its date and first words. Each memory',
    '                             folder has memory.txt (the words, who was there,',
    '                             comments) plus its photos, videos, voice recording',
    '                             and illustration.',
    '  manifest.json              Everything above in a structured format, for',
    '                             moving your memories to another app.',
    '',
    'Photos, videos and recordings are the original files you uploaded.',
  ];
  return `${lines.join('\r\n')}\r\n`;
}
