import {
  buildInviteShareMessage,
  deriveWaitingOutcome,
  formatInviteCodeInput,
  formatInviteExpiry,
  isValidInviteCodeShape,
  normalizeInviteCode,
  pickNewlyJoinedFamilyId,
  type FamilyMembershipLike,
} from '@/utils/invites';

describe('normalizeInviteCode', () => {
  it('lowercases and trims', () => {
    expect(normalizeInviteCode('  SUNNY-TIGER-LAKE  ')).toBe('sunny-tiger-lake');
  });

  it('collapses whitespace to single dashes', () => {
    expect(normalizeInviteCode('sunny tiger lake')).toBe('sunny-tiger-lake');
    expect(normalizeInviteCode('sunny\t tiger \n lake')).toBe('sunny-tiger-lake');
  });

  it('collapses runs of dashes', () => {
    expect(normalizeInviteCode('sunny--tiger---lake')).toBe('sunny-tiger-lake');
    expect(normalizeInviteCode('sunny - tiger - lake')).toBe('sunny-tiger-lake');
  });

  it('strips leading and trailing dashes', () => {
    expect(normalizeInviteCode('-sunny-tiger-lake-')).toBe('sunny-tiger-lake');
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeInviteCode('')).toBe('');
    expect(normalizeInviteCode('   ')).toBe('');
    expect(normalizeInviteCode('---')).toBe('');
  });
});

describe('isValidInviteCodeShape', () => {
  it('accepts three dash-separated lowercase words', () => {
    expect(isValidInviteCodeShape('sunny-tiger-lake')).toBe(true);
  });

  it('rejects wrong word counts', () => {
    expect(isValidInviteCodeShape('sunny-tiger')).toBe(false);
    expect(isValidInviteCodeShape('sunny-tiger-lake-extra')).toBe(false);
    expect(isValidInviteCodeShape('')).toBe(false);
  });

  it('rejects non-letter characters (normalize first)', () => {
    expect(isValidInviteCodeShape('Sunny-Tiger-Lake')).toBe(false);
    expect(isValidInviteCodeShape('sunny-tiger-lak3')).toBe(false);
  });
});

describe('formatInviteCodeInput', () => {
  it('lowercases and converts spaces to dashes while typing', () => {
    expect(formatInviteCodeInput('Sunny Tiger')).toBe('sunny-tiger');
  });

  it('keeps a trailing dash so mid-code typing is not fought', () => {
    expect(formatInviteCodeInput('sunny-')).toBe('sunny-');
  });

  it('drops digits and punctuation', () => {
    expect(formatInviteCodeInput('sunny!-tiger2-lake')).toBe('sunny-tiger-lake');
  });

  it('never starts with a dash', () => {
    expect(formatInviteCodeInput('-sunny')).toBe('sunny');
  });
});

describe('buildInviteShareMessage', () => {
  it('produces the three-step template matching the no-family screen button', () => {
    expect(buildInviteShareMessage('sunny-tiger-lake', "Rosa's family")).toBe(
      [
        "Hi! I'm journaling our family's memories with Momora and I'd love you to join.",
        '1. Get the app: https://usemomora.com/invite?code=sunny-tiger-lake',
        '2. Sign up, then tap "I have an invite code"',
        '3. Enter code: sunny-tiger-lake',
        'The code expires in 7 days.',
      ].join('\n'),
    );
  });

  it('embeds the code in both the universal link and the manual step', () => {
    const message = buildInviteShareMessage('brave-otter-moon', 'Any family');
    expect(message).toContain('https://usemomora.com/invite?code=brave-otter-moon');
    expect(message).toContain('Enter code: brave-otter-moon');
  });
});

describe('formatInviteExpiry', () => {
  const now = new Date('2026-07-10T12:00:00Z');

  it('reports days when more than a day remains', () => {
    expect(formatInviteExpiry('2026-07-16T12:00:01Z', now)).toBe('Expires in 6d');
  });

  it('reports hours when under a day remains', () => {
    expect(formatInviteExpiry('2026-07-10T17:30:00Z', now)).toBe('Expires in 5h');
  });

  it('reports the final hour', () => {
    expect(formatInviteExpiry('2026-07-10T12:30:00Z', now)).toBe('Expires within the hour');
  });

  it('reports expiry once past', () => {
    expect(formatInviteExpiry('2026-07-10T11:59:59Z', now)).toBe('Expired');
  });

  it('treats malformed dates as expired', () => {
    expect(formatInviteExpiry('not-a-date', now)).toBe('Expired');
  });
});

describe('deriveWaitingOutcome (waiting screen state machine)', () => {
  const row = (status: string, familyUnavailable = false) => ({
    invite_id: 'invite-1',
    status,
    family_name: "Rosa's family",
    family_unavailable: familyUnavailable,
  });

  it('keeps waiting while the invite is redeemed but unresolved', () => {
    expect(deriveWaitingOutcome(row('redeemed'))).toEqual({
      kind: 'waiting',
      familyName: "Rosa's family",
    });
  });

  it('resolves to approved', () => {
    expect(deriveWaitingOutcome(row('approved'))).toEqual({
      kind: 'approved',
      familyName: "Rosa's family",
    });
  });

  it('resolves to rejected', () => {
    expect(deriveWaitingOutcome(row('rejected'))).toEqual({
      kind: 'rejected',
      familyName: "Rosa's family",
    });
  });

  it('is terminal when the family became unavailable, regardless of status', () => {
    expect(deriveWaitingOutcome(row('redeemed', true))).toEqual({ kind: 'unavailable' });
    expect(deriveWaitingOutcome(row('approved', true))).toEqual({ kind: 'unavailable' });
  });

  it('is terminal when there is no redeemed invite at all', () => {
    expect(deriveWaitingOutcome(null)).toEqual({ kind: 'unavailable' });
  });

  it('is terminal for unexpected statuses (e.g. revoked mid-wait) instead of polling forever', () => {
    expect(deriveWaitingOutcome(row('revoked'))).toEqual({ kind: 'unavailable' });
  });
});

describe('pickNewlyJoinedFamilyId', () => {
  const membership = (familyId: string, name: string): FamilyMembershipLike => ({
    familyId,
    name,
  });

  it('picks the family present in the refreshed list but not the snapshot', () => {
    const previous = [membership('family-a', "A's family")];
    const refreshed = [membership('family-a', "A's family"), membership('family-b', "B's family")];

    expect(pickNewlyJoinedFamilyId(previous, refreshed, "B's family")).toBe('family-b');
  });

  it('falls back to matching by family name when the diff finds nothing new', () => {
    // e.g. the redeemer re-opened the app after approval already landed, so
    // the membership was already present in both snapshots.
    const previous = [membership('family-a', "A's family"), membership('family-b', "B's family")];
    const refreshed = [membership('family-a', "A's family"), membership('family-b', "B's family")];

    expect(pickNewlyJoinedFamilyId(previous, refreshed, "B's family")).toBe('family-b');
  });

  it('returns null when neither the diff nor the name match finds a candidate', () => {
    const previous = [membership('family-a', "A's family")];
    const refreshed = [membership('family-a', "A's family")];

    expect(pickNewlyJoinedFamilyId(previous, refreshed, "Nonexistent family")).toBeNull();
  });

  it('returns null with no fallback name and nothing new in the diff', () => {
    const previous = [membership('family-a', "A's family")];
    const refreshed = [membership('family-a', "A's family")];

    expect(pickNewlyJoinedFamilyId(previous, refreshed, null)).toBeNull();
  });

  it('prefers the diff result over the name match when both would match', () => {
    // Two families could plausibly share a display name; the diff (which of
    // them is actually new) is the more reliable signal.
    const previous = [membership('family-a', 'Our family')];
    const refreshed = [membership('family-a', 'Our family'), membership('family-b', 'Our family')];

    expect(pickNewlyJoinedFamilyId(previous, refreshed, 'Our family')).toBe('family-b');
  });

  it('handles an empty previous snapshot (first-ever membership)', () => {
    const refreshed = [membership('family-a', "A's family")];

    expect(pickNewlyJoinedFamilyId([], refreshed, "A's family")).toBe('family-a');
  });
});
