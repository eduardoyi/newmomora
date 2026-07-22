import {
  deriveMemoryType,
  formatDisplayDate,
  formatMemoryExcerpt,
  formatVideoDurationLabel,
  getIllustrationStatusLabel,
  isIllustrationInProgress,
  groupMemoriesByDate,
  ILLUSTRATION_GENERATION_STALE_MS,
  ILLUSTRATION_PENDING_RECOVERY_MS,
  getIllustrationRecoveryStartedAt,
  isIllustrationGenerationStale,
  isIllustrationPendingTooLong,
  needsIllustrationRecovery,
  validateMemoryContent,
  validateMemoryDate,
  validateMemoryMediaAssets,
  validateIllustrationMemberLimit,
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

  it('allows unlimited unique tags and rejects duplicates', () => {
    expect(validateTaggedMembers(Array.from({ length: 20 }, (_, index) => `member-${index}`))).toBeNull();
    expect(validateTaggedMembers(['a', 'a'])).toMatch(/duplicate/i);
  });

  it('limits illustration participants to six', () => {
    expect(validateIllustrationMemberLimit(['a', 'b', 'c', 'd', 'e', 'f'])).toBeNull();
    expect(validateIllustrationMemberLimit(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toMatch(
      /up to 6/i,
    );
  });

  it('rejects invalid persisted media aspect ratios', () => {
    expect(validateMemoryMediaAssets([{
      objectKey: 'video.mp4',
      contentType: 'video/mp4',
      aspectRatio: 9 / 16,
    }])).toBeNull();
    expect(validateMemoryMediaAssets([{
      objectKey: 'video.mp4',
      contentType: 'video/mp4',
      aspectRatio: Number.NaN,
    }])).toMatch(/aspect ratio/i);
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

  it('uses the dedicated generation clock and distinct pending/generating recovery windows', () => {
    const now = Date.parse('2026-05-28T12:00:00Z');
    const staleGenerationStartedAt = new Date(
      now - ILLUSTRATION_GENERATION_STALE_MS - 1000,
    ).toISOString();
    const stalePendingStartedAt = new Date(
      now - ILLUSTRATION_PENDING_RECOVERY_MS - 1000,
    ).toISOString();
    const freshUpdatedAt = new Date(now - 60_000).toISOString();

    expect(
      isIllustrationGenerationStale(
        {
          illustration_status: 'generating',
          illustration_generation_started_at: staleGenerationStartedAt,
          updated_at: freshUpdatedAt,
        },
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
        {
          illustration_status: 'pending',
          illustration_generation_started_at: stalePendingStartedAt,
          updated_at: freshUpdatedAt,
        },
        now,
      ),
    ).toBe(true);
    expect(
      needsIllustrationRecovery(
        {
          memory_type: 'text_illustration',
          illustration_status: 'generating',
          illustration_generation_started_at: staleGenerationStartedAt,
          updated_at: freshUpdatedAt,
        },
        now,
      ),
    ).toBe(true);
    expect(
      needsIllustrationRecovery(
        {
          memory_type: 'text_illustration',
          illustration_status: 'ready',
          illustration_generation_started_at: staleGenerationStartedAt,
          updated_at: freshUpdatedAt,
        },
        now,
      ),
    ).toBe(false);
  });

  it('recovers a never-dispatched pending row using its legacy fallback clock', () => {
    const now = Date.parse('2026-05-28T12:00:00Z');
    const staleCreatedAt = new Date(now - ILLUSTRATION_PENDING_RECOVERY_MS - 1).toISOString();

    expect(
      getIllustrationRecoveryStartedAt({
        illustration_generation_started_at: null,
        updated_at: 'not-a-date',
        created_at: staleCreatedAt,
      }),
    ).toBe(Date.parse(staleCreatedAt));
    expect(
      isIllustrationPendingTooLong(
        {
          illustration_status: 'pending',
          illustration_generation_started_at: null,
          updated_at: 'not-a-date',
          created_at: staleCreatedAt,
        },
        now,
      ),
    ).toBe(true);
  });

  it('does not supersede a Workflow at five minutes, but recovers it at five minutes thirty seconds', () => {
    const now = Date.parse('2026-05-28T12:00:00Z');
    const fiveMinuteStartedAt = new Date(now - 5 * 60 * 1000).toISOString();
    const leaseBoundaryStartedAt = new Date(
      now - ILLUSTRATION_GENERATION_STALE_MS,
    ).toISOString();

    expect(
      isIllustrationGenerationStale(
        {
          illustration_status: 'generating',
          illustration_generation_started_at: fiveMinuteStartedAt,
          updated_at: fiveMinuteStartedAt,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isIllustrationGenerationStale(
        {
          illustration_status: 'generating',
          illustration_generation_started_at: leaseBoundaryStartedAt,
          updated_at: leaseBoundaryStartedAt,
        },
        now,
      ),
    ).toBe(true);
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
