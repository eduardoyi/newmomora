import {
  deriveMemoryType,
  formatDisplayDate,
  formatMemoryExcerpt,
  formatVideoDurationLabel,
  getIllustrationStatusLabel,
  isIllustrationInProgress,
  groupMemoriesByDate,
  ILLUSTRATION_GENERATION_STALE_MS,
  isIllustrationGenerationStale,
  isIllustrationPendingTooLong,
  needsIllustrationRecovery,
  validateMemoryContent,
  validateMemoryDate,
  validateTaggedMembers,
} from '@/utils/memories';

describe('memories utils', () => {
  it('validates memory content by type', () => {
    expect(validateMemoryContent('', 'text_illustration')).toMatch(/required/i);
    expect(validateMemoryContent('  hello  ', 'text_only')).toBeNull();
    expect(validateMemoryContent(null, 'media')).toBeNull();
    expect(validateMemoryContent('caption', 'media')).toBeNull();
  });

  it('validates memory date format', () => {
    expect(validateMemoryDate('2026-05-24')).toBeNull();
    expect(validateMemoryDate('05/24/2026')).toMatch(/YYYY-MM-DD/);
  });

  it('enforces max tag count', () => {
    expect(validateTaggedMembers(['a', 'b', 'c', 'd', 'e'])).toMatch(/up to 4/);
    expect(validateTaggedMembers(['a', 'b'])).toBeNull();
  });

  it('formats excerpts and dates', () => {
    expect(formatMemoryExcerpt(null)).toBe('');
    expect(formatMemoryExcerpt('short')).toBe('short');
    expect(formatMemoryExcerpt('x'.repeat(200)).endsWith('…')).toBe(true);
    expect(formatDisplayDate('2026-05-24')).toContain('2026');
    expect(formatVideoDurationLabel(45_000)).toBe('0:45');
  });

  it('formatMemoryExcerpt leaves raw URLs untouched when linkPreviews is omitted', () => {
    expect(formatMemoryExcerpt('Check out https://example.com today')).toBe(
      'Check out https://example.com today',
    );
  });

  it('formatMemoryExcerpt substitutes fetched titles before truncating', () => {
    const previews = {
      'https://example.com': { title: 'Example Site', fetchedAt: '2026-07-01T00:00:00Z' },
    };
    expect(formatMemoryExcerpt('Check out https://example.com today', 140, previews)).toBe(
      'Check out (Example Site) today',
    );
  });

  it('formatMemoryExcerpt falls back to the domain label when no title is fetched yet', () => {
    expect(formatMemoryExcerpt('See https://www.example.com/page', 140, {})).toBe(
      'See (example.com)',
    );
  });

  it('formatMemoryExcerpt truncates after substitution, not before', () => {
    const longUrl = `https://example.com/${'x'.repeat(150)}`;
    const previews = { [longUrl]: { title: null, fetchedAt: '2026-07-01T00:00:00Z' } };
    const rawContent = `Look at this: ${longUrl}`;
    expect(rawContent.length).toBeGreaterThan(140); // would need truncation on its own

    const result = formatMemoryExcerpt(rawContent, 140, previews);
    // The substituted "(example.com)" label is short -- truncation should
    // act on the substituted string, not the raw (much longer) content.
    expect(result).toBe('Look at this: (example.com)');
    expect(result.endsWith('…')).toBe(false);
  });

  it('groups memories by date descending', () => {
    const grouped = groupMemoriesByDate([
      { memory_date: '2026-05-20' },
      { memory_date: '2026-05-24' },
      { memory_date: '2026-05-24' },
    ]);

    expect(grouped[0]?.date).toBe('2026-05-24');
    expect(grouped[0]?.items).toHaveLength(2);
  });

  it('detects in-progress illustration status', () => {
    expect(isIllustrationInProgress('pending')).toBe(true);
    expect(isIllustrationInProgress('generating')).toBe(true);
    expect(isIllustrationInProgress('ready')).toBe(false);
    expect(isIllustrationInProgress('failed')).toBe(false);
  });

  it('returns illustration status labels', () => {
    expect(getIllustrationStatusLabel('none')).toBe('');
    expect(getIllustrationStatusLabel('ready')).toMatch(/ready/i);
    expect(getIllustrationStatusLabel('failed')).toMatch(/failed/i);
  });

  it('detects stale illustration generation and pending recovery', () => {
    const now = Date.parse('2026-05-28T12:00:00Z');
    const staleUpdatedAt = new Date(now - ILLUSTRATION_GENERATION_STALE_MS - 1000).toISOString();
    const freshUpdatedAt = new Date(now - 60_000).toISOString();

    expect(
      isIllustrationGenerationStale(
        { illustration_status: 'generating', updated_at: staleUpdatedAt },
        now,
      ),
    ).toBe(true);
    expect(
      isIllustrationGenerationStale(
        { illustration_status: 'generating', updated_at: freshUpdatedAt },
        now,
      ),
    ).toBe(false);
    expect(
      isIllustrationPendingTooLong(
        { illustration_status: 'pending', updated_at: staleUpdatedAt },
        now,
      ),
    ).toBe(true);
    expect(
      needsIllustrationRecovery(
        {
          memory_type: 'text_illustration',
          illustration_status: 'generating',
          updated_at: staleUpdatedAt,
        },
        now,
      ),
    ).toBe(true);
    expect(
      needsIllustrationRecovery(
        {
          memory_type: 'text_illustration',
          illustration_status: 'ready',
          updated_at: staleUpdatedAt,
        },
        now,
      ),
    ).toBe(false);
  });

  it('derives memory type from form state', () => {
    expect(
      deriveMemoryType({
        hasAttachedMedia: true,
        illustrationEnabled: true,
      }),
    ).toBe('media');

    expect(
      deriveMemoryType({
        hasAttachedMedia: false,
        illustrationEnabled: false,
      }),
    ).toBe('text_only');
  });
});
