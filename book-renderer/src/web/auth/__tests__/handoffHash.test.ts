import { describe, expect, it } from 'vitest';
import { hasHandoffParam, parseHandoffCode, stripHandoffParam } from '../handoffHash';

const PLAIN = 'A'.repeat(43);
const DASHY = 'Ab-_'.repeat(10) + 'Ab-'; // 43 chars with '-' and '_'
const LEADING_DASH = `-${'x'.repeat(41)}_`;

describe('parseHandoffCode', () => {
  it('reads a 43-char base64url code, including - and _', () => {
    expect(DASHY).toHaveLength(43);
    expect(parseHandoffCode(`#h=${PLAIN}`)).toBe(PLAIN);
    expect(parseHandoffCode(`#h=${DASHY}`)).toBe(DASHY);
    expect(parseHandoffCode(`#h=${LEADING_DASH}`)).toBe(LEADING_DASH);
  });

  it('works with other fragment params in either order', () => {
    expect(parseHandoffCode(`#a=1&h=${DASHY}&b=2`)).toBe(DASHY);
    expect(parseHandoffCode(`h=${DASHY}`)).toBe(DASHY);
  });

  it('rejects absent or malformed codes', () => {
    expect(parseHandoffCode('')).toBeNull();
    expect(parseHandoffCode('#')).toBeNull();
    expect(parseHandoffCode('#other=1')).toBeNull();
    expect(parseHandoffCode('#h=')).toBeNull();
    expect(parseHandoffCode(`#h=${'A'.repeat(42)}`)).toBeNull();
    expect(parseHandoffCode(`#h=${'A'.repeat(44)}`)).toBeNull();
    expect(parseHandoffCode(`#h=${'A'.repeat(42)}=`)).toBeNull();
    expect(parseHandoffCode(`#h=${'A'.repeat(42)}/`)).toBeNull();
  });
});

describe('hasHandoffParam', () => {
  it('is true for any h param, even a malformed one', () => {
    expect(hasHandoffParam(`#h=${PLAIN}`)).toBe(true);
    expect(hasHandoffParam('#h=short')).toBe(true);
    expect(hasHandoffParam('#other=1')).toBe(false);
    expect(hasHandoffParam('')).toBe(false);
  });
});

describe('stripHandoffParam', () => {
  it('removes the whole fragment when h is the only param', () => {
    expect(stripHandoffParam(`#h=${DASHY}`)).toBe('');
    expect(stripHandoffParam(`#h=${LEADING_DASH}`)).toBe('');
  });

  it('keeps other params untouched', () => {
    expect(stripHandoffParam(`#a=1&h=${DASHY}&b=x-y_z`)).toBe('#a=1&b=x-y_z');
    expect(stripHandoffParam(`#h=${DASHY}&b=2`)).toBe('#b=2');
  });

  it('leaves a hash without h alone', () => {
    expect(stripHandoffParam('#section')).toBe('#section');
    expect(stripHandoffParam('')).toBe('');
  });

  it('does not touch a param that merely starts with h', () => {
    expect(stripHandoffParam('#hello=1&h=x')).toBe('#hello=1');
  });
});
