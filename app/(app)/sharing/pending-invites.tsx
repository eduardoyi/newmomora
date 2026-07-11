import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { sharingApprovalsRoute, sharingInviteRoute } from '@/lib/routes';
import type { FamilyInvite } from '@/services/invites';
import { buildInviteShareMessage, formatInviteExpiry } from '@/utils/invites';
import { canEditFamilyContent } from '@/utils/roles';

function statusLabel(invite: FamilyInvite): string {
  if (invite.status === 'redeemed') {
    return 'Awaiting approval';
  }

  return formatInviteExpiry(invite.expires_at);
}

export default function PendingInvitesScreen() {
  const { family, familyId, role } = useFamily();
  const canManage = canEditFamilyContent(role);
  const { pendingInvites, redeemedInvites, isLoading, revokeInvite, isRevoking } =
    useFamilyInvites(familyId, { enabled: canManage });
  const [errorMessage, setErrorMessage] = useState('');

  // Guard on mount: viewers reaching this route directly get bounced back.
  useEffect(() => {
    if (!canManage) {
      router.back();
    }
  }, [canManage]);

  const invites = [...redeemedInvites, ...pendingInvites];

  const handleReshare = async (invite: FamilyInvite) => {
    if (!family) {
      return;
    }

    try {
      await Share.share({ message: buildInviteShareMessage(invite.code, family.name) });
    } catch {
      // Dismissing the share sheet is not an error.
    }
  };

  const handleRevoke = (invite: FamilyInvite) => {
    Alert.alert(
      'Revoke invite',
      `Revoke the code ${invite.code}? It will stop working immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            setErrorMessage('');
            void revokeInvite(invite.id).catch((error) => {
              setErrorMessage(
                error instanceof Error ? error.message : 'Could not revoke the invite',
              );
            });
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
            testID="pending-invites-back"
          >
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
          <Text style={styles.title}>Pending invites</Text>
          <Text style={styles.subtitle}>
            Codes stay live for 7 days. Once someone enters one, approve them here.
          </Text>
        </View>

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : invites.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No open invites</Text>
            <Text style={styles.emptyBody}>
              Invite a family member and their code will show up here.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(sharingInviteRoute)}
              style={styles.emptyCta}
              testID="pending-invites-empty-invite"
            >
              <Text style={styles.emptyCtaText}>Invite a family member</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.list}>
            {invites.map((invite) => {
              const isRedeemed = invite.status === 'redeemed';

              const card = (
                <View key={invite.id} style={styles.card} testID={`pending-invite-${invite.id}`}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.code} testID={`pending-invite-${invite.id}-code`}>
                      {invite.code}
                    </Text>
                    <View style={[styles.roleChip, isRedeemed && styles.redeemedChip]}>
                      <Text style={[styles.roleChipText, isRedeemed && styles.redeemedChipText]}>
                        {invite.role === 'manager' ? 'Manager' : 'Viewer'}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.status}>{statusLabel(invite)}</Text>

                  {isRedeemed ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => router.push(sharingApprovalsRoute)}
                      style={styles.approvalLink}
                      testID={`pending-invite-${invite.id}-approvals`}
                    >
                      <Text style={styles.approvalLinkText}>Review in approvals ›</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.actions}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void handleReshare(invite)}
                        style={styles.shareAction}
                        testID={`pending-invite-${invite.id}-share`}
                      >
                        <Text style={styles.shareActionText}>Share again</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={isRevoking}
                        onPress={() => handleRevoke(invite)}
                        style={styles.revokeAction}
                        testID={`pending-invite-${invite.id}-revoke`}
                      >
                        <Text style={styles.revokeActionText}>Revoke</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              );

              return card;
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
    alignItems: 'flex-start',
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
  emptyCta: {
    marginTop: spacing.xs,
  },
  emptyCtaText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.primary,
  },
  list: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  code: {
    fontFamily: 'SpaceMono',
    fontSize: 16,
    color: colors.ink,
  },
  roleChip: {
    backgroundColor: colors.surface2,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  roleChipText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    color: colors.ink2,
  },
  redeemedChip: {
    backgroundColor: colors.seaSoft,
  },
  redeemedChipText: {
    color: colors.seaInk,
  },
  status: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  approvalLink: {
    alignSelf: 'flex-start',
  },
  approvalLinkText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.primary,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  shareAction: {
    paddingVertical: 4,
  },
  shareActionText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.primary,
  },
  revokeAction: {
    paddingVertical: 4,
  },
  revokeActionText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.error,
  },
});
