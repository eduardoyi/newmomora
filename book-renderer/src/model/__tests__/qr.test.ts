import { describe, expect, it } from 'vitest';
import { shareViewerUrl, MEMORY_VIEWER_BASE_URL } from '../qr';

describe('shareViewerUrl', () => {
  it('builds the memory-viewer URL from the base constant + share token', () => {
    expect(shareViewerUrl('tok-abc123')).toBe(`${MEMORY_VIEWER_BASE_URL}/tok-abc123`);
    expect(shareViewerUrl('tok-abc123')).toBe('https://m.usemomora.com/m/tok-abc123');
  });

  it('percent-encodes a token that needs it, rather than emitting a broken URL', () => {
    expect(shareViewerUrl('tok/weird id')).toBe('https://m.usemomora.com/m/tok%2Fweird%20id');
  });

  it('never fabricates a link for an empty token', () => {
    expect(() => shareViewerUrl('')).toThrow();
  });
});
