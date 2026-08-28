import { describe, expect, it } from 'vitest';

import { formatContentRange, parseRangeHeader } from '../src/range';

describe('parseRangeHeader', () => {
  it('returns null when there is no header', () => {
    expect(parseRangeHeader(null)).toBeNull();
    expect(parseRangeHeader(undefined)).toBeNull();
  });

  it('returns null for a non-bytes unit', () => {
    expect(parseRangeHeader('items=0-1')).toBeNull();
  });

  it('returns null for a malformed header', () => {
    expect(parseRangeHeader('bytes=')).toBeNull();
    expect(parseRangeHeader('bytes=-')).toBeNull();
    expect(parseRangeHeader('bytes=abc-def')).toBeNull();
  });

  it('parses a bounded range', () => {
    expect(parseRangeHeader('bytes=0-999')).toEqual({ offset: 0, length: 1000 });
  });

  it('parses an open-ended range', () => {
    expect(parseRangeHeader('bytes=1000-')).toEqual({ offset: 1000 });
  });

  it('parses a suffix range', () => {
    expect(parseRangeHeader('bytes=-500')).toEqual({ suffix: 500 });
  });

  it('rejects an inverted range', () => {
    expect(parseRangeHeader('bytes=100-50')).toBeNull();
  });

  it('rejects a negative offset', () => {
    expect(parseRangeHeader('bytes=-0')).toBeNull(); // suffix of 0 bytes is meaningless
  });

  it('trims surrounding whitespace', () => {
    expect(parseRangeHeader('  bytes=0-9  ')).toEqual({ offset: 0, length: 10 });
  });
});

describe('formatContentRange', () => {
  it('formats a served range against the total size', () => {
    expect(formatContentRange({ servedOffset: 0, servedLength: 1000, totalSize: 5000 })).toBe('bytes 0-999/5000');
  });

  it('formats a range that reaches the end of the object', () => {
    expect(formatContentRange({ servedOffset: 4500, servedLength: 500, totalSize: 5000 })).toBe('bytes 4500-4999/5000');
  });
});
