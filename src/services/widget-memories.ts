import { supabase } from '@/lib/supabase';
import {
  fetchMemoriesByIds,
  type MemoryWithTags,
  type ServiceError,
} from '@/services/memories';
import {
  WIDGET_CANDIDATE_LIMIT,
  WIDGET_RETAINED_MEMORY_LIMIT,
  classifyWidgetAgeBand,
  type WidgetAgeBand,
} from '@/utils/widget-selection';

export {
  WIDGET_CANDIDATE_LIMIT,
  WIDGET_RETAINED_MEMORY_LIMIT,
} from '@/utils/widget-selection';

export interface WidgetMemoryCandidate {
  id: string;
  memoryDate: string;
  ageBand: WidgetAgeBand;
}

export interface WidgetCandidateClock {
  familyDate: string;
  timezoneName: string;
  nextDayBoundary: string;
}

export interface WidgetMemoryCandidateSet {
  candidates: WidgetMemoryCandidate[];
  /** The authoritative family-local clock returned by the same RPC pass. */
  clock: WidgetCandidateClock | null;
}

export interface WidgetCandidateMemorySet extends WidgetMemoryCandidateSet {
  memories: MemoryWithTags[];
}

export type WidgetMemoryFetchFailure = 'authorization' | 'unavailable';

export interface WidgetMemoryServiceResult<T> {
  data: T | null;
  error: ServiceError | null;
  failure: WidgetMemoryFetchFailure | null;
}

interface WidgetMemoryCandidateRpcRow {
  memory_id: string | null;
  memory_date: string | null;
  age_band: string | null;
  family_date: string | null;
  timezone_name: string | null;
  next_day_boundary: string | null;
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return { message: error.message, code: error.code };
}

function failureForError(error: { code?: string }): WidgetMemoryFetchFailure {
  return error.code === '42501' || error.code === '28000' || error.code === 'PGRST301'
    ? 'authorization'
    : 'unavailable';
}

function isIsoDate(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isInstant(value: string | null): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function isAgeBand(value: string | null): value is WidgetAgeBand {
  return value === 'recent' || value === 'medium' || value === 'old' || value === 'deep';
}

function invalidResponse(message = 'Widget memory candidates returned an invalid response'): ServiceError {
  return { message, code: 'invalid_response' };
}

function parseCandidateResponse(
  rows: unknown,
): { data: WidgetMemoryCandidateSet | null; error: ServiceError | null } {
  if (!Array.isArray(rows) || rows.length > WIDGET_CANDIDATE_LIMIT) {
    return { data: null, error: invalidResponse() };
  }

  const typedRows = rows as unknown[];
  if (typedRows.length === 0) {
    // This is tolerated for an older backend that predates the null-id empty
    // sentinel. The caller can render a neutral card and retry after refresh.
    return {
      data: { candidates: [], clock: null },
      error: null,
    };
  }

  const first = typedRows[0];
  if (!first || typeof first !== 'object') {
    return { data: null, error: invalidResponse() };
  }
  const firstRow = first as WidgetMemoryCandidateRpcRow;
  const clockValues = [firstRow.family_date, firstRow.timezone_name, firstRow.next_day_boundary];
  const hasClock = clockValues.every((value) => typeof value === 'string' && value.length > 0);
  if (
    !hasClock ||
    !isIsoDate(firstRow.family_date) ||
    !isInstant(firstRow.next_day_boundary) ||
    !firstRow.timezone_name ||
    !classifyWidgetAgeBand(firstRow.family_date, firstRow.family_date)
  ) {
    return { data: null, error: invalidResponse() };
  }

  const seen = new Set<string>();
  const candidates: WidgetMemoryCandidate[] = [];

  for (const rawRow of typedRows) {
    if (!rawRow || typeof rawRow !== 'object') {
      return { data: null, error: invalidResponse() };
    }
    const row = rawRow as WidgetMemoryCandidateRpcRow;
    if (
      row.family_date !== firstRow.family_date ||
      row.timezone_name !== firstRow.timezone_name ||
      row.next_day_boundary !== firstRow.next_day_boundary
    ) {
      return { data: null, error: invalidResponse('Widget candidate clock changed within one response') };
    }

    // The database returns one null-id sentinel only when no eligible rows
    // exist. Any other partial/null row is a broken contract and fails closed.
    if (row.memory_id === null) {
      if (
        typedRows.length !== 1 ||
        row.memory_date !== null ||
        row.age_band !== null
      ) {
        return { data: null, error: invalidResponse() };
      }
      continue;
    }

    if (
      typeof row.memory_id !== 'string' ||
      row.memory_id.length === 0 ||
      !isIsoDate(row.memory_date) ||
      !isAgeBand(row.age_band) ||
      seen.has(row.memory_id)
    ) {
      return { data: null, error: invalidResponse() };
    }

    // The SQL labels are authoritative, but this cross-check catches an
    // accidental server/client band mismatch before selection is published.
    const computedBand = classifyWidgetAgeBand(row.memory_date, firstRow.family_date);
    if (computedBand !== row.age_band) {
      return { data: null, error: invalidResponse('Widget candidate age band is inconsistent') };
    }

    seen.add(row.memory_id);
    candidates.push({ id: row.memory_id, memoryDate: row.memory_date, ageBand: row.age_band });
  }

  return {
    data: {
      candidates,
      clock: {
        familyDate: firstRow.family_date,
        timezoneName: firstRow.timezone_name,
        nextDayBoundary: firstRow.next_day_boundary,
      },
    },
    error: null,
  };
}

/** Loads at most forty server-selected IDs and the family-local clock. */
export async function fetchWidgetMemoryCandidates(
  familyId: string,
): Promise<WidgetMemoryServiceResult<WidgetMemoryCandidateSet>> {
  try {
    const { data, error } = await supabase.rpc('get_widget_memory_candidates', {
      p_family_id: familyId,
    });

    if (error) {
      return { data: null, error: mapSupabaseError(error), failure: failureForError(error) };
    }

    const parsed = parseCandidateResponse(data);
    if (parsed.error) {
      return { data: null, error: parsed.error, failure: 'unavailable' };
    }

    return { data: parsed.data, error: null, failure: null };
  } catch (error) {
    const serviceError = {
      message: error instanceof Error ? error.message : 'Could not load widget memory candidates',
    };
    return { data: null, error: serviceError, failure: 'unavailable' };
  }
}

/**
 * Loads and hydrates the fresh candidate sample. Hydration remains the
 * existing RLS-scoped 40-ID path and is independent from retained-card reads.
 */
export async function fetchWidgetCandidateMemories(
  familyId: string,
): Promise<WidgetMemoryServiceResult<WidgetCandidateMemorySet>> {
  const candidatesResult = await fetchWidgetMemoryCandidates(familyId);
  if (candidatesResult.error || !candidatesResult.data) {
    return candidatesResult as WidgetMemoryServiceResult<WidgetCandidateMemorySet>;
  }

  if (candidatesResult.data.candidates.length === 0) {
    return {
      data: { ...candidatesResult.data, memories: [] },
      error: null,
      failure: null,
    };
  }

  let hydrated: { data: MemoryWithTags[] | null; error: ServiceError | null };
  try {
    hydrated = await fetchMemoriesByIds(
      familyId,
      candidatesResult.data.candidates.map((candidate) => candidate.id),
    );
  } catch (error) {
    const serviceError = {
      message: error instanceof Error ? error.message : 'Could not hydrate widget candidates',
    };
    return { data: null, error: serviceError, failure: 'unavailable' };
  }
  if (hydrated.error) {
    return { data: null, error: hydrated.error, failure: failureForError(hydrated.error) };
  }

  return {
    data: { ...candidatesResult.data, memories: hydrated.data ?? [] },
    error: null,
    failure: null,
  };
}

/**
 * Rehydrates current/future manifest IDs through RLS before lease renewal.
 * The seven-ID cap is separate from the fresh forty-ID candidate cap.
 */
export async function fetchWidgetRetainedMemoriesByIds(
  familyId: string,
  memoryIds: readonly string[],
): Promise<WidgetMemoryServiceResult<MemoryWithTags[]>> {
  const requestedIds = [...new Set(memoryIds)];
  if (requestedIds.length > WIDGET_RETAINED_MEMORY_LIMIT) {
    return {
      data: null,
      error: {
        message: `Widget can revalidate at most ${WIDGET_RETAINED_MEMORY_LIMIT} retained memories at once`,
        code: 'validation_error',
      },
      failure: 'unavailable',
    };
  }

  try {
    const result = await fetchMemoriesByIds(familyId, requestedIds);
    if (result.error) {
      return { data: null, error: result.error, failure: failureForError(result.error) };
    }
    return { data: result.data ?? [], error: null, failure: null };
  } catch (error) {
    return {
      data: null,
      error: {
        message: error instanceof Error ? error.message : 'Could not revalidate widget memories',
      },
      failure: 'unavailable',
    };
  }
}

// Short alias for callers that do not need to distinguish retained reads in
// their naming, while keeping the seven-ID guard in one implementation.
export const fetchWidgetMemoriesByIds = fetchWidgetRetainedMemoriesByIds;
