import type { Href } from 'expo-router';

export const addFamilyMemberRoute = '/(app)/add-family-member' as Href;
export const newMemoryRoute = '/(app)/new-memory' as Href;
export const timelineRoute = '/(app)/(tabs)/timeline' as Href;
export const noFamilyRoute = '/(app)/no-family' as Href;

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
