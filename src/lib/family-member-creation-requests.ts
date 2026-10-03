// Hands a newly created family member back to the screen that opened the
// add-person modal (e.g. the memory tag picker, so the new person comes back
// already tagged). Expo Router routes can't return values, so the opener
// registers a listener under a request id, passes the id as a route param,
// and `add-family-member.tsx` resolves it after a successful save. Listeners
// live only in memory: if the opener unmounts first it unregisters, and a
// resolve for an unknown id is a no-op.

type FamilyMemberCreatedListener = (memberId: string) => void;

const listeners = new Map<string, FamilyMemberCreatedListener>();
let nextRequestNumber = 0;

export function registerFamilyMemberCreationRequest(listener: FamilyMemberCreatedListener): {
  requestId: string;
  unregister: () => void;
} {
  nextRequestNumber += 1;
  const requestId = `fm-create-${Date.now().toString(36)}-${nextRequestNumber}`;
  listeners.set(requestId, listener);

  return {
    requestId,
    unregister: () => {
      listeners.delete(requestId);
    },
  };
}

export function resolveFamilyMemberCreationRequest(
  requestId: string | undefined,
  memberId: string,
): void {
  if (!requestId) return;
  const listener = listeners.get(requestId);
  if (!listener) return;
  listeners.delete(requestId);
  listener(memberId);
}
