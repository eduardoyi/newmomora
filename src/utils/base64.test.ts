import { bytesToBase64 } from './base64';

function bytesFromString(input: string): Uint8Array {
  return new Uint8Array([...input].map((ch) => ch.charCodeAt(0)));
}

describe('bytesToBase64', () => {
  it('encodes empty input as an empty string', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
  });

  it('encodes the classic RFC 4648 short vectors', () => {
    expect(bytesToBase64(bytesFromString('M'))).toBe('TQ==');
    expect(bytesToBase64(bytesFromString('Ma'))).toBe('TWE=');
    expect(bytesToBase64(bytesFromString('Man'))).toBe('TWFu');
  });

  it('encodes a buffer spanning multiple 3-byte groups', () => {
    expect(bytesToBase64(bytesFromString('Hello, World!'))).toBe('SGVsbG8sIFdvcmxkIQ==');
  });

  it('round-trips raw byte values including 0 and 255', () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 254, 16]);
    const decoded = Uint8Array.from(Buffer.from(bytesToBase64(bytes), 'base64'));
    expect(decoded).toEqual(bytes);
  });
});
