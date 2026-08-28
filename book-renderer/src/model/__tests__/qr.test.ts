import { describe, expect, it } from 'vitest';
import { memoryViewerUrl, MEMORY_VIEWER_BASE_URL } from '../qr';

describe('memoryViewerUrl', () => {
  it('builds the memory-viewer URL from the base constant + memory id', () => {
    expect(memoryViewerUrl('mem-abc123')).toBe(`${MEMORY_VIEWER_BASE_URL}/mem-abc123`);
    expect(memoryViewerUrl('mem-abc123')).toBe('https://m.momora.app/m/mem-abc123');
  });

  it('percent-encodes a memory id that needs it, rather than emitting a broken URL', () => {
    expect(memoryViewerUrl('mem/weird id')).toBe('https://m.momora.app/m/mem%2Fweird%20id');
  });

  it('never fabricates a link for an empty id', () => {
    expect(() => memoryViewerUrl('')).toThrow();
  });
});
