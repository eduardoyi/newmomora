import { describe, expect, it } from 'vitest';
import { attemptAssetUrl } from '../PrintApp';

/**
 * `attemptAssetUrl` (memory-book-5c plan, Step 2a) — PrintApp.tsx's ATTEMPT
 * mode asset resolution. Pure/exported specifically so this contract (an
 * already-absolute URL passes through; anything else resolves under this
 * attempt's own data prefix) is covered without needing a DOM/fetch harness
 * for the rest of the component.
 */
describe('attemptAssetUrl', () => {
  it('resolves a bare R2 object key relative to the attempt data prefix', () => {
    expect(attemptAssetUrl('attempt-1', 'assets/photo.jpg')).toBe('/attempt/attempt-1/assets/photo.jpg');
  });

  it('passes an already-absolute https URL through unchanged (the future render worker\'s presigned GET)', () => {
    const presigned = 'https://r2.example.com/bucket/assets/photo.jpg?X-Amz-Signature=abc';
    expect(attemptAssetUrl('attempt-1', presigned)).toBe(presigned);
  });

  it('passes an already-absolute http URL through unchanged too', () => {
    expect(attemptAssetUrl('attempt-1', 'http://localhost:9/assets/x.jpg')).toBe('http://localhost:9/assets/x.jpg');
  });

  it('is case-insensitive on the scheme check', () => {
    const presigned = 'HTTPS://r2.example.com/assets/photo.jpg';
    expect(attemptAssetUrl('attempt-1', presigned)).toBe(presigned);
  });

  it('scopes different attempt ids to different prefixes', () => {
    expect(attemptAssetUrl('a', 'assets/x.jpg')).toBe('/attempt/a/assets/x.jpg');
    expect(attemptAssetUrl('b', 'assets/x.jpg')).toBe('/attempt/b/assets/x.jpg');
  });
});
