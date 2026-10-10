import { parseVoiceNoteDate, pickImportedMemoryDate } from '@/utils/voice-note-date';

describe('parseVoiceNoteDate', () => {
  it('reads the WhatsApp iOS send date', () => {
    expect(parseVoiceNoteDate('AUDIO-2026-10-10-15-31-04.m4a')).toBe('2026-10-10');
  });

  it('reads WhatsApp Android PTT and AUD names', () => {
    expect(parseVoiceNoteDate('PTT-20261009-WA0007.opus')).toBe('2026-10-09');
    expect(parseVoiceNoteDate('AUD-20260102-WA0123.m4a')).toBe('2026-01-02');
  });

  it('accepts a leap day and rejects impossible dates', () => {
    expect(parseVoiceNoteDate('PTT-20240229-WA0001.opus')).toBe('2024-02-29');
    expect(parseVoiceNoteDate('PTT-20250229-WA0001.opus')).toBeNull();
    expect(parseVoiceNoteDate('PTT-20261301-WA0001.opus')).toBeNull();
    expect(parseVoiceNoteDate('PTT-20260431-WA0001.opus')).toBeNull();
    expect(parseVoiceNoteDate('AUDIO-2026-00-10-15-31-04.m4a')).toBeNull();
  });

  it('ignores unrelated names', () => {
    expect(parseVoiceNoteDate('New Recording 4.m4a')).toBeNull();
    expect(parseVoiceNoteDate('IMG-20261010-WA0001.jpg')).toBeNull();
    expect(parseVoiceNoteDate('PTT-20261010-WA0001')).toBeNull();
    expect(parseVoiceNoteDate('')).toBeNull();
  });
});

describe('pickImportedMemoryDate', () => {
  const now = new Date(2026, 9, 10, 18, 0, 0); // 2026-10-10 18:00 local

  it('prefers the file-name date over the container creation date', () => {
    expect(
      pickImportedMemoryDate({
        fileName: 'PTT-20261003-WA0001.opus',
        creationDate: new Date(2026, 8, 1, 12, 0, 0).toISOString(),
        now,
      }),
    ).toBe('2026-10-03');
  });

  it('uses a container creation date that is more than 15 minutes old', () => {
    expect(
      pickImportedMemoryDate({
        fileName: 'Recording.m4a',
        creationDate: new Date(2026, 8, 1, 12, 0, 0).toISOString(),
        now,
      }),
    ).toBe('2026-09-01');
  });

  it('ignores an export-time creation date (within 15 minutes of now)', () => {
    expect(
      pickImportedMemoryDate({
        fileName: 'Recording.m4a',
        creationDate: new Date(2026, 9, 10, 17, 50, 0).toISOString(),
        now,
      }),
    ).toBeNull();
    expect(
      pickImportedMemoryDate({
        fileName: 'Recording.m4a',
        creationDate: new Date(2026, 9, 10, 17, 40, 0).toISOString(),
        now,
      }),
    ).toBe('2026-10-10');
  });

  it('never suggests a future date', () => {
    expect(
      pickImportedMemoryDate({
        fileName: 'Recording.m4a',
        creationDate: new Date(2026, 9, 12, 12, 0, 0).toISOString(),
        now,
      }),
    ).toBeNull();
    // A future file-name date is dropped; a trustworthy container date still applies.
    expect(
      pickImportedMemoryDate({
        fileName: 'PTT-20261111-WA0001.opus',
        creationDate: new Date(2026, 8, 1, 12, 0, 0).toISOString(),
        now,
      }),
    ).toBe('2026-09-01');
    expect(
      pickImportedMemoryDate({ fileName: 'PTT-20261111-WA0001.opus', creationDate: null, now }),
    ).toBeNull();
  });

  it('returns null with no usable date', () => {
    expect(pickImportedMemoryDate({ fileName: 'Recording.m4a', creationDate: null, now })).toBeNull();
    expect(
      pickImportedMemoryDate({ fileName: 'Recording.m4a', creationDate: 'not a date', now }),
    ).toBeNull();
  });

  it('accepts a file-name date from today', () => {
    expect(
      pickImportedMemoryDate({ fileName: 'AUDIO-2026-10-10-17-59-59.m4a', creationDate: null, now }),
    ).toBe('2026-10-10');
  });
});
