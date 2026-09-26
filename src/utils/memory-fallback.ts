export type MemoryFallbackKind = 'quote' | 'sound' | 'blank';

/**
 * Which tile stands in for a memory with no image: the same type-aware
 * treatment as the calendar stamp and member-profile thumb (rendered by
 * MemoryFallbackTile).
 */
export function memoryFallbackKind(memoryType: string | null | undefined, mediaContentType?: string | null): MemoryFallbackKind {
  if (memoryType === 'audio' || mediaContentType?.startsWith('audio/')) return 'sound';
  // text_only, or a text_illustration whose illustration hasn't landed.
  if (memoryType === 'text_only' || memoryType === 'text_illustration') return 'quote';
  return 'blank';
}
