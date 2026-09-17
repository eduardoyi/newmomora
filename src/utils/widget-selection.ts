/**
 * Pure selection and timeline helpers for the home-screen widget.
 *
 * The widget deliberately uses calendar dates only for the age bands and
 * rotation boundaries. Lease expiry is always elapsed time from the
 * successful validation pass, so a DST transition cannot extend or shorten
 * the seven-day authorization window.
 */

export const WIDGET_CANDIDATE_LIMIT = 40;
export const WIDGET_RETAINED_MEMORY_LIMIT = 7;
export const WIDGET_TIMELINE_SLOT_COUNT = 7;
/** Maximum number of entries a daytime-capable native widget can accept. */
export const WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT = 24;
export const WIDGET_MAX_TIMELINE_ENTRIES = WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT;
export const WIDGET_LEASE_HOURS = 168;
export const WIDGET_LEASE_MS = WIDGET_LEASE_HOURS * 60 * 60 * 1000;

/** Family-local daylight rotation boundaries, expressed as local hours. */
export const WIDGET_DAYTIME_BOUNDARY_HOURS = [8, 13, 18] as const;

export const widgetAgeBands = ['recent', 'medium', 'old', 'deep'] as const;
export type WidgetAgeBand = (typeof widgetAgeBands)[number];

export interface WidgetSelectionCandidate {
  id: string;
  memoryDate: string;
  ageBand?: WidgetAgeBand;
}

export interface WidgetSelectionOptions {
  familyId: string;
  familyDate: string;
  candidates: readonly WidgetSelectionCandidate[];
  /** IDs scheduled in the device's previous seven slots/days. */
  recentScheduledIds?: readonly string[];
  slotCount?: number;
}

export interface WidgetSelectionSlot {
  slotIndex: number;
  memoryId: string;
}

export interface WidgetTimelineEntry extends WidgetSelectionSlot {
  /** The exact instant at which this entry becomes eligible to display. */
  startsAt: string;
  /** The next slot start, or the fixed lease expiry for the last slot. */
  endsAt: string;
  localDate: string;
}

export interface WidgetTimeline {
  entries: WidgetTimelineEntry[];
  verifiedAt: string;
  expiresAt: string;
  /** A neutral card may be scheduled at this instant on platforms that need it. */
  neutralAt: string;
  timezoneName: string;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function parseCalendarDate(value: string): CalendarDate | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function formatCalendarDate(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function compareCalendarDates(left: CalendarDate, right: CalendarDate): number {
  if (left.year !== right.year) return left.year - right.year;
  if (left.month !== right.month) return left.month - right.month;
  return left.day - right.day;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  const absoluteMonth = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = ((absoluteMonth % 12) + 12) % 12 + 1;
  const day = Math.min(date.day, daysInMonth(year, month));
  return { year, month, day };
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Classifies a memory using the same calendar boundaries as the RPC. */
export function classifyWidgetAgeBand(
  memoryDate: string,
  familyDate: string,
): WidgetAgeBand | null {
  const memory = parseCalendarDate(memoryDate);
  const current = parseCalendarDate(familyDate);
  if (!memory || !current) {
    return null;
  }

  // Future/imported dates are intentionally part of the recent band. The
  // strict comparisons keep a date exactly 90/18/36 months old in the older
  // band, matching the SQL CASE expression.
  if (compareCalendarDates(memory, addCalendarDays(current, -90)) > 0) {
    return 'recent';
  }
  if (compareCalendarDates(memory, addCalendarMonths(current, -18)) > 0) {
    return 'medium';
  }
  if (compareCalendarDates(memory, addCalendarMonths(current, -36)) > 0) {
    return 'old';
  }
  return 'deep';
}

/** Returns a stable, small integer hash without platform-specific crypto. */
export function widgetStableHash(value: string): number {
  // FNV-1a gives the same result in Hermes, Node, and the native test runner.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeCandidate(
  candidate: WidgetSelectionCandidate,
  familyDate: string,
): WidgetSelectionCandidate | null {
  if (!candidate.id || !parseCalendarDate(candidate.memoryDate)) {
    return null;
  }

  const ageBand = candidate.ageBand ?? classifyWidgetAgeBand(candidate.memoryDate, familyDate);
  if (!ageBand) {
    return null;
  }

  return { ...candidate, ageBand };
}

function uniqueCandidates(
  candidates: readonly WidgetSelectionCandidate[],
  familyDate: string,
): WidgetSelectionCandidate[] {
  const seen = new Set<string>();
  const result: WidgetSelectionCandidate[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate, familyDate);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    result.push(normalized);
  }

  return result;
}

function stableCandidateOrder(
  candidates: readonly WidgetSelectionCandidate[],
  seed: string,
): WidgetSelectionCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftHash = widgetStableHash(`${seed}:${left.id}`);
    const rightHash = widgetStableHash(`${seed}:${right.id}`);
    if (leftHash !== rightHash) {
      return leftHash - rightHash;
    }
    return left.id.localeCompare(right.id);
  });
}

/**
 * Selects seven daily cards. Age bands are interleaved, IDs are unique until
 * the pool is exhausted, and recently scheduled IDs are deferred while a
 * fresh candidate remains. Repetition is then allowed for small archives.
 */
export function selectWidgetMemorySlots(
  options: WidgetSelectionOptions,
): WidgetSelectionSlot[] {
  const slotCount = Math.min(
    WIDGET_TIMELINE_SLOT_COUNT,
    Math.max(0, Math.floor(options.slotCount ?? WIDGET_TIMELINE_SLOT_COUNT)),
  );
  if (slotCount === 0) {
    return [];
  }

  const candidates = uniqueCandidates(
    options.candidates.slice(0, WIDGET_CANDIDATE_LIMIT),
    options.familyDate,
  );
  if (candidates.length === 0) {
    return [];
  }

  const seed = `${options.familyId}:${options.familyDate}`;
  const recentIds = new Set(options.recentScheduledIds ?? []);
  const groups = new Map<WidgetAgeBand, WidgetSelectionCandidate[]>();
  for (const band of widgetAgeBands) {
    const bandCandidates = candidates.filter((candidate) => candidate.ageBand === band);
    if (bandCandidates.length > 0) {
      const ordered = stableCandidateOrder(bandCandidates, `${seed}:${band}`);
      // Keep the stable hash order inside each group, while deferring recent
      // history until every fresh ID in that group has had a chance to fill a
      // slot. Splitting the order up front avoids losing deferred IDs when a
      // fresh item occurs later than a recent item in the hash order.
      groups.set(band, [
        ...ordered.filter((candidate) => !recentIds.has(candidate.id)),
        ...ordered.filter((candidate) => recentIds.has(candidate.id)),
      ]);
    }
  }

  const bands = [...groups.keys()].sort((left, right) => {
    const leftHash = widgetStableHash(`${seed}:band:${left}`);
    const rightHash = widgetStableHash(`${seed}:band:${right}`);
    return leftHash - rightHash || left.localeCompare(right);
  });
  if (bands.length === 0) {
    return [];
  }

  const cursors = new Map<WidgetAgeBand, number>(bands.map((band) => [band, 0]));
  const exhausted = new Set<string>();
  const firstPass: WidgetSelectionCandidate[] = [];

  // Round-robin over the non-empty age bands. During the first cycle prefer a
  // candidate that was not scheduled in the device's recent history, but do
  // not consume an ID twice until every distinct candidate was considered.
  for (let pass = 0; pass < 2 && firstPass.length < candidates.length; pass += 1) {
    let madeProgress = true;
    while (madeProgress && firstPass.length < candidates.length) {
      madeProgress = false;
      for (const band of bands) {
        const items = groups.get(band) ?? [];
        let cursor = cursors.get(band) ?? 0;
        while (cursor < items.length && exhausted.has(items[cursor].id)) {
          cursor += 1;
        }

        if (cursor >= items.length) {
          cursors.set(band, cursor);
          continue;
        }

        // Pass zero skips recent IDs when this band has a fresh one later in
        // its order. Pass one consumes the deferred IDs.
        if (pass === 0 && recentIds.has(items[cursor].id)) {
          const freshIndex = items.findIndex(
            (item, index) => index >= cursor && !exhausted.has(item.id) && !recentIds.has(item.id),
          );
          if (freshIndex >= 0) {
            cursor = freshIndex;
          } else {
            continue;
          }
        }

        const selected = items[cursor];
        cursors.set(band, cursor + 1);
        exhausted.add(selected.id);
        firstPass.push(selected);
        madeProgress = true;

        if (firstPass.length >= candidates.length) {
          break;
        }
      }
    }
  }

  // A candidate pool smaller than the requested timeline repeats its stable
  // order. This is intentional: one saved memory remains useful immediately.
  const orderedUnique = firstPass;
  const selected: WidgetSelectionSlot[] = [];
  for (let index = 0; index < slotCount; index += 1) {
    const candidate = orderedUnique[index % orderedUnique.length];
    selected.push({ slotIndex: index, memoryId: candidate.id });
  }

  return selected;
}

function parseInstant(value: Date | string): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validTimeZone(timezoneName: string): string {
  try {
    // Constructing the formatter validates the IANA name in all supported JS
    // runtimes. UTC is the server's documented fallback.
    new Intl.DateTimeFormat('en-US', { timeZone: timezoneName }).format();
    return timezoneName;
  } catch {
    return 'UTC';
  }
}

function timeZoneParts(instant: Date, timezoneName: string): CalendarDate & {
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneName,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function wallClockKey(
  parts: CalendarDate & { hour: number; minute: number; second: number },
): string {
  return `${formatCalendarDate(parts)}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
}

/**
 * Resolves a local wall-clock boundary to UTC. The common path uses the
 * timezone offset at a few fixed-point guesses, which also handles quarter-
 * hour zones. A bounded search is the fallback for a skipped local time.
 */
function zonedLocalDateTimeToUtc(
  date: CalendarDate,
  hour: number,
  timezoneName: string,
): Date | null {
  const targetMillis = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0);
  const targetKey = `${formatCalendarDate(date)}T${String(hour).padStart(2, '0')}:00:00`;
  let guess = targetMillis;

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const parts = timeZoneParts(new Date(guess), timezoneName);
    const localMillis = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    guess = targetMillis - (localMillis - guess);
    const resolved = new Date(guess);
    if (wallClockKey(timeZoneParts(resolved, timezoneName)) === targetKey) {
      return resolved;
    }
  }

  // Local 08:00/13:00/18:00 almost always exists. If a timezone skips a
  // wall-clock range, only accept an exact result; the caller will skip that
  // boundary and continue with the next one.
  let low = targetMillis - 72 * 60 * 60 * 1000;
  let high = targetMillis + 72 * 60 * 60 * 1000;
  for (let iteration = 0; iteration < 52 && high - low > 1; iteration += 1) {
    const middle = Math.floor((low + high) / 2);
    const middleKey = wallClockKey(timeZoneParts(new Date(middle), timezoneName));
    if (middleKey < targetKey) low = middle;
    else high = middle;
  }
  const fallback = new Date(high);
  return Number.isNaN(fallback.getTime())
    || wallClockKey(timeZoneParts(fallback, timezoneName)) !== targetKey
    ? null
    : fallback;
}

function zonedMidnightToUtc(date: CalendarDate, timezoneName: string): Date {
  const naiveUtc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const targetDate = formatCalendarDate(date);

  // Find the first instant whose local calendar date is the target date. A
  // fixed-point offset calculation is smaller, but it oscillates in zones
  // that skip midnight (for example America/Santiago). Date comparison is
  // monotonic even across a DST change, so a bounded binary search handles
  // both ordinary and skipped local midnights.
  let low = naiveUtc.getTime() - 48 * 60 * 60 * 1000;
  let high = naiveUtc.getTime() + 48 * 60 * 60 * 1000;
  for (let iteration = 0; iteration < 48 && high - low > 1; iteration += 1) {
    const middle = Math.floor((low + high) / 2);
    const middleDate = formatCalendarDate(timeZoneParts(new Date(middle), timezoneName));
    if (middleDate < targetDate) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return new Date(high);
}

export function widgetLocalDateAt(instant: Date | string, timezoneName: string): string | null {
  const parsed = parseInstant(instant);
  if (!parsed) {
    return null;
  }
  const timezone = validTimeZone(timezoneName);
  return formatCalendarDate(timeZoneParts(parsed, timezone));
}

/** Returns the next family-local midnight after the supplied instant. */
export function widgetNextLocalMidnight(
  instant: Date | string,
  timezoneName: string,
): Date | null {
  const parsed = parseInstant(instant);
  if (!parsed) {
    return null;
  }
  const timezone = validTimeZone(timezoneName);
  const local = timeZoneParts(parsed, timezone);
  return zonedMidnightToUtc(addCalendarDays(local, 1), timezone);
}

/** Returns the next strict 08:00, 13:00, or 18:00 family-local boundary. */
export function widgetNextLocalDaytimeBoundary(
  instant: Date | string,
  timezoneName: string,
): Date | null {
  const parsed = parseInstant(instant);
  if (!parsed) return null;

  const timezone = validTimeZone(timezoneName);
  const local = timeZoneParts(parsed, timezone);
  const localMinutes = local.hour * 60 + local.minute + local.second / 60;
  for (let dayOffset = 0; dayOffset < 4; dayOffset += 1) {
    const date = addCalendarDays(local, dayOffset);
    for (const hour of WIDGET_DAYTIME_BOUNDARY_HOURS) {
      if (dayOffset === 0 && localMinutes >= hour * 60) continue;
      const candidate = zonedLocalDateTimeToUtc(date, hour, timezone);
      if (candidate && candidate.getTime() > parsed.getTime()) return candidate;
    }
  }
  return null;
}

function uniqueTimelineSlots(slots: readonly WidgetSelectionSlot[]): WidgetSelectionSlot[] {
  const seen = new Set<string>();
  const unique: WidgetSelectionSlot[] = [];
  for (const slot of slots) {
    if (!slot.memoryId || seen.has(slot.memoryId)) continue;
    seen.add(slot.memoryId);
    unique.push(slot);
    if (unique.length >= WIDGET_TIMELINE_SLOT_COUNT) break;
  }
  return unique;
}

function normalizedTimelineEntryLimit(value: number | undefined): number {
  // Native exposes a deliberately tiny capability contract: seven means the
  // existing daily schedule, while 24 opts into daytime coverage. Unknown,
  // fractional, and intermediate values stay on the safe legacy cadence.
  if (value === undefined || !Number.isFinite(value) || !Number.isInteger(value)) {
    return WIDGET_TIMELINE_SLOT_COUNT;
  }
  return value >= WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT
    ? WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT
    : WIDGET_TIMELINE_SLOT_COUNT;
}

/**
 * Builds a lease timeline. The first slot starts at validation time; legacy
 * entries start at successive local midnights, while a daytime-capable
 * timeline uses strict 08:00/13:00/18:00 boundaries. Expiry is always exactly
 * 168 elapsed hours after validation.
 */
export function buildWidgetTimeline(input: {
  verifiedAt: Date | string;
  timezoneName: string;
  familyId?: string;
  familyDate?: string;
  candidates?: readonly WidgetSelectionCandidate[];
  recentScheduledIds?: readonly string[];
  slots?: readonly WidgetSelectionSlot[];
  /** Native timeline capacity. Missing/7 keeps the legacy daily cadence. */
  maxTimelineEntries?: number;
}): WidgetTimeline | null {
  const verified = parseInstant(input.verifiedAt);
  if (!verified) {
    return null;
  }

  const timezone = validTimeZone(input.timezoneName);
  const familyDate = input.familyDate ?? widgetLocalDateAt(verified, timezone);
  if (!familyDate) {
    return null;
  }
  const slots = (
    input.slots ??
    (input.familyId && input.candidates
      ? selectWidgetMemorySlots({
          familyId: input.familyId,
          familyDate,
          candidates: input.candidates,
          recentScheduledIds: input.recentScheduledIds,
        })
      : []));
  const maxTimelineEntries = normalizedTimelineEntryLimit(input.maxTimelineEntries);
  const daytimeTimeline = maxTimelineEntries > WIDGET_TIMELINE_SLOT_COUNT;
  // The legacy path intentionally retains seven repeated daily slots for a
  // small archive. Daytime schedules instead cycle unique IDs so the wrap
  // from the final selected slot never repeats a card back-to-back.
  const boundedSlots = daytimeTimeline
    ? uniqueTimelineSlots(slots)
    : slots.slice(0, Math.min(WIDGET_TIMELINE_SLOT_COUNT, maxTimelineEntries));

  if (boundedSlots.length === 0 || maxTimelineEntries === 0) {
    return {
      entries: [],
      verifiedAt: verified.toISOString(),
      expiresAt: new Date(verified.getTime() + WIDGET_LEASE_MS).toISOString(),
      neutralAt: new Date(verified.getTime() + WIDGET_LEASE_MS).toISOString(),
      timezoneName: timezone,
    };
  }

  const expires = new Date(verified.getTime() + WIDGET_LEASE_MS);
  const starts: Date[] = [verified];
  if (daytimeTimeline) {
    while (starts.length < maxTimelineEntries) {
      const next = widgetNextLocalDaytimeBoundary(starts[starts.length - 1], timezone);
      if (!next || next.getTime() >= expires.getTime()) break;
      // A timezone conversion must make progress. If a pathological timezone
      // rule maps a skipped boundary backwards, stop rather than looping.
      if (next.getTime() <= starts[starts.length - 1].getTime()) break;
      starts.push(next);
    }
  } else {
    for (let index = 1; index < boundedSlots.length; index += 1) {
      const previous = widgetNextLocalMidnight(starts[index - 1], timezone);
      if (!previous) return null;
      starts.push(previous);
    }
  }

  const entries = starts.map((start, index) => {
    const slot = boundedSlots[index % boundedSlots.length];
    const nextStart = starts[index + 1] ?? expires;
    const end = nextStart.getTime() < expires.getTime() ? nextStart : expires;
    return {
      slotIndex: index,
      memoryId: slot.memoryId,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      localDate: widgetLocalDateAt(start, timezone) ?? familyDate,
    };
  });

  return {
    entries,
    verifiedAt: verified.toISOString(),
    expiresAt: expires.toISOString(),
    neutralAt: expires.toISOString(),
    timezoneName: timezone,
  };
}

export function widgetTimelineIsExpired(
  timeline: Pick<WidgetTimeline, 'expiresAt'>,
  now: Date | string = new Date(),
): boolean {
  const expires = parseInstant(timeline.expiresAt);
  const current = parseInstant(now);
  return !expires || !current || current.getTime() >= expires.getTime();
}
