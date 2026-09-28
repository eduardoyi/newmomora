// suggest-family-relationships (docs/features/family-relationships.md,
// TECH_SPEC §4): proposes who each person is to the kids, their family side,
// and nicknames the family uses -- as PENDING suggestions an owner/manager
// confirms in the Who's who sheet. Never writes family_members.
//
// Called by the app when an owner/manager opens the Family tab; the server
// throttles (claim_relationship_suggestion_run: <= 1 run / 24h, or / 1h after
// a new member), skips when there's nothing new to sort, and backs off ~1h
// after a failure (fail_relationship_suggestion_run).
//
// PII: logs carry counts and error names only -- never names, memory text,
// the prompt or the model output.
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { checkBillingFamilyWrite } from '../_shared/billing.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole } from '../_shared/family-access.ts';
import {
  buildSuggestionPrompt,
  type FamilySignals,
  nothingToSuggest,
  SUGGESTION_SYSTEM_PROMPT,
  validateSuggestions,
} from '../_shared/family-relationship-suggestions.ts';
import { chatJson } from '../_shared/openai.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SuggestFamilyRelationshipsRequest {
  familyId: string;
}

export type SuggestFamilyRelationshipsResponse =
  | { skipped: true; reason: 'throttled' | 'nothing_new' }
  | { skipped: false; suggested: number };

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

export interface SuggestServiceClient {
  rpc(name: string, args: Record<string, unknown>): RpcResult;
}

export interface SuggestFamilyRelationshipsDependencies {
  getAuthenticatedUser: (req: Request) => Promise<{ id: string } | null>;
  createServiceClient: () => SuggestServiceClient;
  getFamilyRole: (service: SuggestServiceClient, familyId: string, userId: string) => Promise<string | null>;
  checkBilling: (service: SuggestServiceClient, familyId: string, userId: string) => Promise<Response | null>;
  countMemoriesSince: (service: SuggestServiceClient, familyId: string, since: string) => Promise<number>;
  chatJson: <T>(systemPrompt: string, userPrompt: string, options: {
    usageContext: { attributionScope: 'family'; familyId: string; actorUserId: string; operation: 'relationship_chat' };
  }) => Promise<T>;
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

export async function handleSuggestFamilyRelationshipsWithDependencies(
  req: Request,
  deps: SuggestFamilyRelationshipsDependencies,
): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const user = await deps.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: Partial<SuggestFamilyRelationshipsRequest>;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  const familyId = body?.familyId;
  if (typeof familyId !== 'string' || !UUID_PATTERN.test(familyId)) {
    return errorResponse('familyId is invalid', 400, 'validation_error');
  }

  const service = deps.createServiceClient();
  const role = await deps.getFamilyRole(service, familyId, user.id);
  if (role !== 'owner' && role !== 'manager') {
    return errorResponse('Not authorized for this family', 403, 'forbidden');
  }
  const billingResponse = await deps.checkBilling(service, familyId, user.id);
  if (billingResponse) return billingResponse;

  const claim = await service.rpc('claim_relationship_suggestion_run', { p_family_id: familyId });
  if (claim.error) {
    console.error('suggest-family-relationships claim failed', errorName(claim.error));
    return errorResponse('Could not start suggestions', 500, 'SUGGESTION_FAILED');
  }
  const claimRow = (Array.isArray(claim.data) ? claim.data[0] : claim.data) as
    | { claimed: boolean; previous_suggested_at: string | null }
    | null;
  if (!claimRow?.claimed) {
    return jsonResponse({ skipped: true, reason: 'throttled' } satisfies SuggestFamilyRelationshipsResponse);
  }

  try {
    const signalsResult = await service.rpc('family_relationship_signals', { p_family_id: familyId });
    if (signalsResult.error) throw signalsResult.error;
    const signals = signalsResult.data as FamilySignals;

    const since = claimRow.previous_suggested_at;
    const newMemories = since ? await deps.countMemoriesSince(service, familyId, since) : 1;
    if (nothingToSuggest(signals, newMemories)) {
      return jsonResponse({ skipped: true, reason: 'nothing_new' } satisfies SuggestFamilyRelationshipsResponse);
    }

    const reply = await deps.chatJson<unknown>(SUGGESTION_SYSTEM_PROMPT, buildSuggestionPrompt(signals), {
      usageContext: { attributionScope: 'family', familyId, actorUserId: user.id, operation: 'relationship_chat' },
    });
    const rows = validateSuggestions(signals, reply);

    let inserted = 0;
    if (rows.length > 0) {
      const insert = await service.rpc('insert_family_member_suggestions', { p_family_id: familyId, p_rows: rows });
      if (insert.error) throw insert.error;
      inserted = typeof insert.data === 'number' ? insert.data : 0;
    }

    console.log('suggest-family-relationships done', { proposed: rows.length, inserted });
    return jsonResponse({ skipped: false, suggested: inserted } satisfies SuggestFamilyRelationshipsResponse);
  } catch (error) {
    console.error('suggest-family-relationships failed', errorName(error));
    const backoff = await service.rpc('fail_relationship_suggestion_run', { p_family_id: familyId });
    if (backoff.error) console.error('suggest-family-relationships backoff failed', errorName(backoff.error));
    return errorResponse('Could not suggest relationships', 500, 'SUGGESTION_FAILED');
  }
}

export function handleSuggestFamilyRelationships(req: Request): Promise<Response> {
  return handleSuggestFamilyRelationshipsWithDependencies(req, {
    getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
    createServiceClient,
    getFamilyRole: (service, familyId, userId) =>
      getCallerFamilyRole(service as ReturnType<typeof createServiceClient>, familyId, userId),
    checkBilling: (service, familyId, userId) =>
      checkBillingFamilyWrite(service as ReturnType<typeof createServiceClient>, familyId, userId, 'relationship_suggestions'),
    countMemoriesSince: async (service, familyId, since) => {
      const { count, error } = await (service as ReturnType<typeof createServiceClient>)
        .from('memories')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .gt('created_at', since);
      if (error) throw error;
      return count ?? 0;
    },
    chatJson,
  });
}

if (import.meta.main) {
  serveWithSentry('suggest-family-relationships', handleSuggestFamilyRelationships);
}
