import type { Href } from 'expo-router';

export const rootRoute = '/' as Href;
export const addFamilyMemberRoute = '/(app)/add-family-member' as Href;

// `memory_saved.source` (docs/plans/analytics-tracking.md Tier 2) needs to
// know which entry point opened the composer -- carried as a route param
// (read by new-memory.tsx, defaults to `'other'` when omitted) rather than
// component state, since the FAB, the incoming-share router, and the push
// notification handler each navigate here from a different module with no
// shared state to stash it in.
export type NewMemorySource = 'fab_timeline' | 'fab_calendar' | 'share_sheet' | 'notification';

export function newMemoryRoute(source?: NewMemorySource): Href {
  if (!source) {
    return '/(app)/new-memory' as Href;
  }

  return {
    pathname: '/(app)/new-memory',
    params: { source },
  } as Href;
}

export const timelineRoute = '/(app)/(tabs)/timeline' as Href;
export const noFamilyRoute = '/(app)/no-family' as Href;

export function lookingBackPackageRoute(packageId: string): Href {
  return { pathname: '/(app)/looking-back/[id]', params: { id: packageId } } as unknown as Href;
}
// The kids roster tab ("The cast") -- app/(app)/(tabs)/family.tsx. Named
// `familyRosterRoute`, not `familyRoute`, to avoid colliding with the
// per-member `familyMemberRoute`/`editFamilyMemberRoute` below and with the
// children-vs-household naming hazard this file already calls out for
// `sharing/*` (see that comment): this route is the children roster, not
// the family-sharing/household surface.
export const familyRosterRoute = '/(app)/(tabs)/family' as Href;

// Family sharing (household) routes -- deliberately under `sharing/`, not
// `family/` (that group means the *children* roster; see plan §9 on the
// children-vs-household naming hazard).
export const sharingInviteRoute = '/(app)/sharing/invite' as Href;
export const sharingManageRoute = '/(app)/sharing/manage' as Href;
export const sharingMembersRoute = '/(app)/sharing/members' as Href;
export const sharingPendingInvitesRoute = '/(app)/sharing/pending-invites' as Href;
export const sharingApprovalsRoute = '/(app)/sharing/approvals' as Href;
export const sharingRedeemRoute = '/(app)/sharing/redeem' as Href;
export const sharingWaitingRoute = '/(app)/sharing/waiting' as Href;
export const signupRoute = '/(auth)/signup' as Href;

export function sharingWaitingRouteWithName(familyName: string): Href {
  return { pathname: '/(app)/sharing/waiting', params: { familyName } } as unknown as Href;
}

// `mediaIndex` opens the detail screen's media carousel on that page -- the
// asset the user was already looking at in a list carousel. Omitted (or 0)
// keeps the plain string route so existing callers and deep links are
// unchanged.
export function memoryDetailRoute(memoryId: string, mediaIndex?: number): Href {
  if (!mediaIndex) {
    return `/(app)/memory/${memoryId}` as Href;
  }

  return {
    pathname: '/(app)/memory/[id]',
    params: { id: memoryId, mediaIndex: String(mediaIndex) },
  } as Href;
}

export function memoryDetailCommentsRoute(memoryId: string): Href {
  return {
    pathname: '/(app)/memory/[id]',
    params: { id: memoryId, comments: '1' },
  } as Href;
}

export function editMemoryRoute(memoryId: string): Href {
  return `/(app)/memory/${memoryId}/edit` as Href;
}

export function familyMemberRoute(memberId: string): Href {
  return `/(app)/family/${memberId}` as Href;
}

export function editFamilyMemberRoute(memberId: string): Href {
  return `/(app)/family/${memberId}/edit` as Href;
}

export function portraitTimelineRoute(memberId: string): Href {
  return `/(app)/family/${memberId}/portraits` as Href;
}
