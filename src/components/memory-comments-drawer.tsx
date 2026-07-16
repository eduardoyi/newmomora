import { Send } from 'lucide-react-native';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { ContentActionSheet } from '@/components/content-action-sheet';
import { ReportSheet } from '@/components/report-sheet';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useMemoryEngagement } from '@/hooks/useMemoryEngagement';
import { useContentSafety } from '@/hooks/useContentSafety';
import { resolveAttributionName, useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useUserProfile } from '@/hooks/useUserProfile';
import { MAX_COMMENT_LENGTH, type MemoryComment } from '@/services/engagement';
import type { MemoryWithTags } from '@/services/memories';
import { formatEngagementTimestamp } from '@/utils/engagement';
import { canEditFamilyContent } from '@/utils/roles';

interface MemoryCommentsDrawerProps {
  memory: MemoryWithTags;
  visible: boolean;
  onClose: () => void;
}

export function getCommentsKeyboardAvoidingBehavior(
  platform: string,
  isKeyboardVisible: boolean,
) {
  if (platform === 'ios') return 'padding' as const;
  if (platform === 'android' && isKeyboardVisible) return 'height' as const;
  return undefined;
}

export function getCommentsDrawerBottomPadding(
  bottomInset: number,
  isKeyboardVisible: boolean,
) {
  return isKeyboardVisible ? 0 : Math.max(bottomInset, spacing.md);
}

export function MemoryCommentsDrawer({ memory, visible, onClose }: MemoryCommentsDrawerProps) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { familyId, role } = useFamily();
  const { profile } = useUserProfile();
  const { profiles } = useFamilyMemberProfiles(familyId);
  const engagement = useMemoryEngagement(memory, { commentsEnabled: visible });
  const contentSafety = useContentSafety();
  const [text, setText] = useState('');
  const [actionComment, setActionComment] = useState<MemoryComment | null>(null);
  const [reportComment, setReportComment] = useState<MemoryComment | null>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const listRef = useRef<FlatList<MemoryComment>>(null);
  const canModerate = canEditFamilyContent(role);
  const currentName = profile?.name ?? 'You';

  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
      setIsKeyboardVisible(true);
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      setIsKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const handleClose = () => {
    Keyboard.dismiss();
    setIsKeyboardVisible(false);
    setText('');
    onClose();
  };

  const authorName = (comment: MemoryComment) => {
    if (comment.user_id === user?.id) return currentName;
    return resolveAttributionName(profiles, comment.user_id);
  };

  const canDeleteComment = (comment: MemoryComment) =>
    comment.user_id === user?.id || canModerate;

  const confirmDelete = (comment: MemoryComment) => {
    if (!canDeleteComment(comment) || comment.id.startsWith('optimistic-')) return;
    Alert.alert('Delete comment?', 'This comment will be permanently deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void engagement.deleteComment(comment).catch(() => {
            Alert.alert('Could not delete comment', 'Please try again.');
          });
        },
      },
    ]);
  };

  const submit = async () => {
    const content = text.trim();
    if (!content || content.length > MAX_COMMENT_LENGTH || engagement.isAddingComment) return;
    setText('');
    try {
      await engagement.addComment(content);
    } catch {
      setText(content);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={getCommentsKeyboardAvoidingBehavior(Platform.OS, isKeyboardVisible)}
        style={styles.root}
        testID="comments-keyboard-avoiding-view"
      >
        <Pressable
          accessibilityLabel="Close comments"
          accessibilityRole="button"
          onPress={handleClose}
          style={styles.backdrop}
          testID="comments-drawer-backdrop"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              paddingBottom: getCommentsDrawerBottomPadding(
                insets.bottom,
                isKeyboardVisible,
              ),
            },
          ]}
          testID="comments-drawer"
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>Comments</Text>
            {engagement.commentCount > 0 ? (
              <Text style={styles.headerCount}>{engagement.commentCount}</Text>
            ) : null}
          </View>

          {contentSafety.isLoading || engagement.areCommentsLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : contentSafety.isError ? (
            <View style={styles.centered}>
              <Text style={styles.errorText}>Could not safely load comments</Text>
              <Pressable onPress={() => void contentSafety.refetch()}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : engagement.commentsError ? (
            <View style={styles.centered}>
              <Text style={styles.errorText}>Could not load comments</Text>
              <Pressable onPress={() => void engagement.refetchComments()}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              contentContainerStyle={[
                styles.listContent,
                engagement.comments.length === 0 && styles.emptyListContent,
              ]}
              data={engagement.comments}
              keyExtractor={(comment) => comment.id}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
              ref={listRef}
              style={styles.list}
              renderItem={({ item }) => {
                const name = authorName(item);
                const mine = item.user_id === user?.id;
                const isBlocked = contentSafety.isUserBlocked(item.user_id);
                const isReported = contentSafety.isTargetReported('comment', item.id);
                const hasActiveReport = contentSafety.hasActiveReport('comment', item.id);
                const canDelete = canDeleteComment(item);
                const isHidden = isBlocked || isReported;
                return (
                  <View style={styles.commentRow} testID={`comment-${item.id}`}>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{isBlocked ? '•' : name.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={styles.commentBody}>
                      <View style={styles.commentMeta}>
                        <Text style={styles.author} numberOfLines={1}>
                          {isBlocked ? 'Blocked account' : `${name}${mine ? ' · you' : ''}`}
                        </Text>
                        <Text style={styles.timestamp}>{formatEngagementTimestamp(item.created_at)}</Text>
                      </View>
                      {isHidden ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            if (isReported) contentSafety.revealTarget('comment', item.id);
                            if (isBlocked) contentSafety.revealBlockedUser(item.user_id);
                          }}
                          testID={`comment-${item.id}-show`}
                        >
                          <Text style={styles.hiddenCommentText}>Comment hidden · Show anyway</Text>
                        </Pressable>
                      ) : <Text style={styles.commentText}>{item.content}</Text>}
                    </View>
                    {!item.id.startsWith('optimistic-') && (canDelete || !hasActiveReport) ? (
                      <Pressable
                        accessibilityLabel={`Comment actions for ${isBlocked ? 'blocked account' : name}`}
                        accessibilityRole="button"
                        onPress={() => setActionComment(item)}
                        style={styles.commentActions}
                        testID={`comment-${item.id}-actions`}
                      >
                        <SymbolView
                          fallback={<Text style={styles.commentActionsFallback}>•••</Text>}
                          name={{ ios: 'ellipsis', android: 'more_horiz' }}
                          size={16}
                          tintColor={colors.ink3}
                        />
                      </Pressable>
                    ) : null}
                  </View>
                );
              }}
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>No comments yet</Text>
                  <Text style={styles.emptyBody}>Be the first to say something.</Text>
                </View>
              }
              showsVerticalScrollIndicator={false}
              testID="comments-list"
            />
          )}

          <View style={styles.composer}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{currentName.charAt(0).toUpperCase()}</Text>
            </View>
            <TextInput
              maxLength={MAX_COMMENT_LENGTH}
              multiline
              onChangeText={setText}
              placeholder="Add a comment…"
              placeholderTextColor={colors.ink3}
              style={styles.input}
              testID="comment-input"
              value={text}
            />
            <Pressable
              accessibilityLabel="Post comment"
              accessibilityRole="button"
              disabled={!text.trim() || engagement.isAddingComment}
              onPress={() => void submit()}
              style={[
                styles.sendButton,
                (!text.trim() || engagement.isAddingComment) && styles.sendButtonDisabled,
              ]}
              testID="comment-submit"
            >
              {engagement.isAddingComment ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <Send color={colors.white} size={17} strokeWidth={2} />
              )}
            </Pressable>
          </View>
          {engagement.addCommentError ? (
            <Text style={styles.composerError}>Could not post comment. Please try again.</Text>
          ) : null}
        </View>
        <ContentActionSheet
          actions={actionComment ? [
            ...(canDeleteComment(actionComment) ? [{
              danger: true,
              label: 'Delete comment',
              onPress: () => confirmDelete(actionComment),
              testID: 'comment-action-delete',
            }] : []),
            ...(!contentSafety.hasActiveReport('comment', actionComment.id) ? [{
              danger: true,
              label: 'Report comment',
              onPress: () => setReportComment(actionComment),
              testID: 'comment-action-report',
            }] : []),
          ] : []}
          onClose={() => setActionComment(null)}
          testID="comment-actions-sheet"
          visible={Boolean(
            actionComment &&
            (canDeleteComment(actionComment) || !contentSafety.hasActiveReport('comment', actionComment.id))
          )}
        />
        {reportComment ? (
          <ReportSheet
            isSubmitting={contentSafety.isReporting}
            onClose={() => setReportComment(null)}
            onSubmit={(reason, note) => contentSafety.report({
              targetType: 'comment',
              targetId: reportComment.id,
              reason,
              note,
            }).then(() => undefined)}
            targetLabel="comment"
            targetType="comment"
            visible
          />
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44,36,24,0.34)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    flex: 1,
    maxHeight: '80%',
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: radius.pill,
    height: 5,
    marginTop: 10,
    width: 40,
  },
  header: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  title: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 18 },
  headerCount: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 13 },
  centered: { alignItems: 'center', flex: 1, gap: spacing.sm, justifyContent: 'center' },
  errorText: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14 },
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  list: { flex: 1 },
  listContent: { gap: 20, paddingBottom: 10, paddingHorizontal: 20, paddingTop: 18 },
  emptyListContent: { flexGrow: 1 },
  emptyState: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  emptyTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  emptyBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13, marginTop: 4 },
  commentRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 11 },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  avatarText: { color: colors.primaryDark, fontFamily: fonts.displayMedium, fontSize: 16 },
  commentBody: { flex: 1, minWidth: 0 },
  commentMeta: { alignItems: 'baseline', flexDirection: 'row', gap: 8 },
  author: { color: colors.ink, flexShrink: 1, fontFamily: fonts.sansBold, fontSize: 13.5 },
  timestamp: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 11 },
  commentText: { color: colors.ink, fontFamily: fonts.sans, fontSize: 14, lineHeight: 21, marginTop: 2 },
  hiddenCommentText: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 20, marginTop: 2 },
  commentActions: { alignItems: 'center', height: 44, justifyContent: 'center', marginRight: -8, width: 44 },
  commentActionsFallback: { color: colors.ink3, fontSize: 12 },
  composer: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    maxHeight: 84,
    minHeight: 42,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  sendButtonDisabled: { backgroundColor: colors.borderStrong },
  composerError: {
    color: colors.error,
    fontFamily: fonts.sans,
    fontSize: 11,
    paddingHorizontal: 60,
    paddingTop: 4,
  },
});
