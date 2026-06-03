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
