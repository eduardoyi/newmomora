import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import {
  familyInvitesQueryKey,
  familyMemberProfilesQueryKey,
} from '@/hooks/queryKeys';
import {
  fetchInviteRedeemer,
  resolveFamilyInvite,
  type FamilyInvite,
  type InviteRedeemer,
} from '@/services/invites';
import { canEditFamilyContent } from '@/utils/roles';

interface ApprovalEntry {
  invite: FamilyInvite;
  redeemer: InviteRedeemer | null;
}

export default function ApprovalsScreen() {
  const { familyId, role } = useFamily();
  const queryClient = useQueryClient();
  const canManage = canEditFamilyContent(role);
  const { redeemedInvites, isLoading: isInvitesLoading } = useFamilyInvites(familyId, {
    enabled: canManage,
  });
  const [resolvingInviteId, setResolvingInviteId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  // Guard on mount: viewers reaching this route directly get bounced back.
  useEffect(() => {
    if (!canManage) {
      router.back();
    }
  }, [canManage]);

  const redeemedIds = redeemedInvites.map((invite) => invite.id);

  const redeemersQuery = useQuery({
    queryKey: ['invite-redeemers', familyId, ...redeemedIds],
    queryFn: async (): Promise<ApprovalEntry[]> => {
      return Promise.all(
        redeemedInvites.map(async (invite) => {
          const { data } = await fetchInviteRedeemer(invite.id);
          return { invite, redeemer: data };
        }),
      );
    },
    enabled: canManage && redeemedInvites.length > 0,
  });

  const entries = redeemersQuery.data ?? [];
  const isLoading = isInvitesLoading || (redeemedInvites.length > 0 && redeemersQuery.isLoading);

  const handleResolve = async (invite: FamilyInvite, action: 'approve' | 'reject') => {
    setErrorMessage('');
    setResolvingInviteId(invite.id);

    try {
      const { error } = await resolveFamilyInvite(invite.id, action);

      if (error) {
        throw new Error(error.message);
      }

      // Optimistic-ish refresh: the invite list drives this screen, so
      // invalidating it removes the resolved entry; approvals also change
      // the member list.
      queryClient.invalidateQueries({ queryKey: familyInvitesQueryKey(familyId) });
      if (action === 'approve') {
        queryClient.invalidateQueries({ queryKey: familyMemberProfilesQueryKey(familyId) });
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not resolve the invite');
    } finally {
      setResolvingInviteId(null);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
            testID="approvals-back"
          >
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
          <Text style={styles.title}>Approvals</Text>
          <Text style={styles.subtitle}>
            Check it&apos;s really them before they join your family journal.
          </Text>
        </View>

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : redeemedInvites.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Nothing to approve</Text>
            <Text style={styles.emptyBody}>
              When someone enters an invite code, they&apos;ll appear here for you to approve.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {entries.map(({ invite, redeemer }) => {
              const isResolving = resolvingInviteId === invite.id;

              return (
                <View key={invite.id} style={styles.card} testID={`approval-${invite.id}`}>
                  <Text style={styles.redeemerName}>{redeemer?.name ?? 'Unknown'}</Text>
                  {redeemer?.email ? <Text style={styles.redeemerEmail}>{redeemer.email}</Text> : null}
                  <Text style={styles.meta}>
                    Joining as {invite.role === 'manager' ? 'manager' : 'viewer'} · code {invite.code}
                  </Text>

                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={isResolving}
                      onPress={() => void handleResolve(invite, 'approve')}
                      style={({ pressed }) => [
                        styles.approveButton,
                        isResolving && styles.buttonDisabled,
                        pressed && !isResolving && styles.approveButtonPressed,
                      ]}
                      testID={`approval-${invite.id}-approve`}
                    >
                      {isResolving ? (
                        <ActivityIndicator color={colors.white} size="small" />
                      ) : (
                        <Text style={styles.approveButtonText}>Approve</Text>
                      )}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={isResolving}
                      onPress={() => void handleResolve(invite, 'reject')}
                      style={[styles.rejectButton, isResolving && styles.buttonDisabled]}
                      testID={`approval-${invite.id}-reject`}
                    >
                      <Text style={styles.rejectButtonText}>Reject</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
  },
  header: {
    gap: spacing.sm,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontFamily: fonts.sansBold,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 34,
    color: colors.ink,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink3,
  },
  error: {
    color: colors.error,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  centered: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  emptyCard: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  emptyTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    color: colors.ink,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.ink3,
  },
  list: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 6,
    padding: spacing.md,
  },
  redeemerName: {
    fontFamily: fonts.displayMedium,
    fontSize: 18,
    color: colors.ink,
  },
  redeemerEmail: {
    fontFamily: 'SpaceMono',
    fontSize: 12.5,
    color: colors.ink3,
  },
  meta: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  approveButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 12,
  },
  approveButtonPressed: {
    backgroundColor: colors.primaryDark,
  },
  approveButtonText: {
    fontFamily: fonts.sansBold,
    color: colors.white,
    fontSize: 15,
  },
  rejectButton: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 12,
  },
  rejectButtonText: {
    fontFamily: fonts.sansBold,
    color: colors.error,
    fontSize: 15,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
