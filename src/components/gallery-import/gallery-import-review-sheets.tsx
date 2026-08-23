// Gallery import -- the review flow's two bottom sheets (design:
// gi-review-sheets.jsx): the day's photo pool, and the set-aside list.
// Editing a draft is the memory composer, not a sheet.
//
// The photo pool is the candidate's server-admitted cluster reconstructed
// from the local checkpoint (see buildGalleryImportDayPool). From the deck
// the chooser is browse-only -- the deck is read-only per
// docs/design/gallery-import/README.md; selection editing happens when the
// chooser is opened from the composer's Add-photos seam.
import { Image } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GALLERY_IMPORT_MAX_ASSETS_PER_CLUSTER } from '@/constants/gallery-import';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { GalleryImportCandidate } from '@/services/gallery-import';
import type { GalleryImportDayPoolAsset } from '@/utils/gallery-import-deck';
import { getGalleryImportE2eAdapter } from '@/utils/gallery-import-e2e-adapter';
import { createExpoGalleryMediaLibraryAdapter } from '@/utils/gallery-import-scanner';
import { formatFullDisplayDate, formatMemoryExcerpt } from '@/utils/memories';

export const GALLERY_IMPORT_PHOTO_CHOICE_MAX = GALLERY_IMPORT_MAX_ASSETS_PER_CLUSTER;

export interface GalleryImportChosenPhoto {
  assetToken: string;
  /** Local display uri for pool photos beyond the candidate's previews. */
  uri?: string;
}

// ── Shared sheet chrome ──────────────────────────────────────────────────
function GallerySheet({
  title,
  subtitle,
  closeLabel,
  onClose,
  footer,
  children,
  testID,
}: {
  title: string;
  subtitle?: string;
  closeLabel: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
  testID: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close" onPress={onClose} style={styles.scrim} testID={`${testID}-scrim`} />
        <View accessibilityViewIsModal style={styles.sheet} testID={testID}>
          <View style={styles.grabberRow}><View style={styles.grabber} /></View>
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderCopy}>
              <Text style={styles.sheetTitle}>{title}</Text>
              {subtitle ? <Text style={styles.sheetSubtitle}>{subtitle}</Text> : null}
            </View>
            <Pressable accessibilityRole="button" hitSlop={10} onPress={onClose} testID={`${testID}-close`}>
              <Text style={styles.sheetClose}>{closeLabel}</Text>
            </Pressable>
          </View>
          <View style={styles.sheetBody}>{children}</View>
          {footer ? <View style={[styles.sheetFooter, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>{footer}</View> : null}
          {!footer ? <View style={{ height: Math.max(insets.bottom, 16) + 8 }} /> : null}
        </View>
      </View>
    </Modal>
  );
}

// ── Choose (or browse) the day's photos ──────────────────────────────────
export function GalleryImportPhotoChooser({
  candidate,
  pool,
  mode,
  initialSelected,
  onClose,
  onUseSelection,
}: {
  candidate: Pick<GalleryImportCandidate, 'memoryDate' | 'selectedAssetTokens' | 'previewUrls'>;
  pool: GalleryImportDayPoolAsset[];
  /** 'browse' from the read-only deck; 'select' from the composer seam. */
  mode: 'browse' | 'select';
  /** Select mode only: the composer's current ordered selection. */
  initialSelected?: string[];
  onClose: () => void;
  /** Select mode only: called with the ordered selection on Done. */
  onUseSelection?: (photos: GalleryImportChosenPhoto[]) => void;
}) {
  const max = GALLERY_IMPORT_PHOTO_CHOICE_MAX;
  const [selected, setSelected] = useState<string[]>(
    () => (mode === 'select' ? initialSelected ?? candidate.selectedAssetTokens : candidate.selectedAssetTokens),
  );
  const previewByToken = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    candidate.selectedAssetTokens.forEach((token, index) => { map[token] = candidate.previewUrls?.[index]; });
    return map;
  }, [candidate.previewUrls, candidate.selectedAssetTokens]);
  // Pool photos beyond the candidate's previews render straight from the
  // device library. URIs stay in component state only -- never logged,
  // persisted, or sent anywhere.
  const [localUriByToken, setLocalUriByToken] = useState<Record<string, string>>({});
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);
  useEffect(() => {
    const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
    let cancelled = false;
    void (async () => {
      for (const asset of pool) {
        if (cancelled) return;
        if (previewByToken[asset.assetToken]) continue;
        try {
          const uri = await adapter.resolveAssetUri(asset.osAssetId);
          if (!cancelled && isMountedRef.current && uri) {
            setLocalUriByToken((current) => current[asset.assetToken] ? current : { ...current, [asset.assetToken]: uri });
          }
        } catch {
          // A missing original renders as an empty tile; approval re-verifies.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pool, previewByToken]);

  const atCap = selected.length >= max;
  const toggle = (token: string) => {
    if (mode !== 'select') return;
    setSelected((current) => {
      if (current.includes(token)) {
        // Never below one photo -- a memory keeps at least one.
        return current.length === 1 ? current : current.filter((item) => item !== token);
      }
      return current.length >= max ? current : [...current, token];
    });
  };
  const done = () => {
    if (mode === 'select' && onUseSelection) {
      onUseSelection(selected.map((token) => ({ assetToken: token, uri: previewByToken[token] ?? localUriByToken[token] })));
    }
    onClose();
  };

  return (
    <GallerySheet
      closeLabel="Done"
      footer={mode === 'select' ? (
        <View style={styles.chooserFooter}>
          <View style={styles.chooserFooterCopy}>
            <Text style={styles.chooserFooterTitle}>{selected.length} of {max} chosen</Text>
            <Text style={styles.chooserFooterHint} testID="gallery-import-chooser-cap">
              {atCap ? 'That is the most one memory can hold.' : 'Tap a photo to add or remove it.'}
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={done} style={styles.chooserUseButton} testID="gallery-import-chooser-use">
            <Text style={styles.chooserUseButtonText}>Use these {selected.length}</Text>
          </Pressable>
        </View>
      ) : undefined}
      onClose={done}
      subtitle={`${pool.length} ${pool.length === 1 ? 'photo' : 'photos'} from ${formatFullDisplayDate(candidate.memoryDate)}, all still on your phone.`}
      testID="gallery-import-photo-chooser"
      title="Photos from that day"
    >
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={styles.chooserGrid}>
          {pool.map((asset) => {
            const token = asset.assetToken;
            const on = selected.includes(token);
            const order = selected.indexOf(token) + 1;
            const capBlocked = mode === 'select' && !on && atCap;
            const uri = previewByToken[token] ?? localUriByToken[token];
            return (
              <Pressable
                accessibilityLabel={on ? `Photo ${order}, included` : 'Not included'}
                accessibilityRole={mode === 'select' ? 'checkbox' : 'image'}
                accessibilityState={mode === 'select' ? { checked: on, disabled: capBlocked } : undefined}
                disabled={mode !== 'select' || capBlocked}
                key={token}
                onPress={() => toggle(token)}
                style={[styles.chooserTile, capBlocked && styles.chooserTileBlocked]}
                testID={`gallery-import-chooser-photo-${token}`}
              >
                {uri ? (
                  <Image contentFit="cover" source={{ uri }} style={styles.chooserTileImage} />
                ) : (
                  <View style={styles.chooserTileEmpty} />
                )}
                <View pointerEvents="none" style={[styles.chooserTileRing, on && styles.chooserTileRingOn]} />
                <View style={[styles.chooserBadge, on ? styles.chooserBadgeOn : styles.chooserBadgeOff]}>
                  {on ? <Text style={styles.chooserBadgeText} testID={`gallery-import-chooser-order-${token}`}>{order}</Text> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </GallerySheet>
  );
}

// ── Set aside -- recoverable, never a bin ────────────────────────────────
export function GalleryImportSetAsideSheet({
  candidates,
  isActioning,
  onBringBack,
  onClose,
}: {
  candidates: GalleryImportCandidate[];
  isActioning: boolean;
  onBringBack: (candidate: GalleryImportCandidate) => void;
  onClose: () => void;
}) {
  return (
    <GallerySheet
      closeLabel="Done"
      onClose={onClose}
      testID="gallery-import-set-aside-sheet"
      title="Set aside"
    >
      <FlatList
        ListEmptyComponent={<Text style={styles.asideEmpty}>Nothing is set aside right now.</Text>}
        ListFooterComponent={
          candidates.length > 0 ? <Text style={styles.asideReassureText}>Won’t be suggested again.</Text> : null
        }
        contentContainerStyle={styles.asideList}
        data={candidates}
        keyExtractor={(candidate) => candidate.id}
        renderItem={({ item: candidate }) => (
          <View style={styles.asideRow}>
            {candidate.previewUrls?.[0] ? (
              <Image contentFit="cover" source={{ uri: candidate.previewUrls[0] }} style={styles.asideThumb} testID={`gallery-import-aside-thumb-${candidate.id}`} />
            ) : (
              <View style={[styles.asideThumb, styles.asideThumbEmpty]} testID={`gallery-import-aside-thumb-empty-${candidate.id}`} />
            )}
            <View style={styles.asideCopy}>
              <Text numberOfLines={2} style={styles.asideCaption}>{formatMemoryExcerpt(candidate.caption, 60)}</Text>
              {/* Same long-form date as the deck card and the photo chooser
                  header -- one date format across every deck surface
                  (defect #3 guard), not a shorter one-off for this row. */}
              <Text style={styles.asideDate}>{formatFullDisplayDate(candidate.memoryDate)}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={isActioning}
              onPress={() => onBringBack(candidate)}
              style={({ pressed }) => [styles.bringBack, (pressed || isActioning) && styles.bringBackPressed]}
              testID={`gallery-import-restore-${candidate.id}`}
            >
              <Text style={styles.bringBackText}>Bring back</Text>
            </Pressable>
          </View>
        )}
        testID="gallery-import-set-aside-scroll"
      />
    </GallerySheet>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(36,28,18,0.34)', flex: 1, justifyContent: 'flex-end' },
  scrim: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '88%',
  },
  grabberRow: { alignItems: 'center', paddingBottom: 2, paddingTop: 10 },
  grabber: { backgroundColor: colors.border, borderRadius: radius.pill, height: 5, width: 38 },
  sheetHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, paddingHorizontal: spacing.lg, paddingTop: 8 },
  sheetHeaderCopy: { flex: 1 },
  sheetTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 24 },
  sheetSubtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, marginTop: 5 },
  sheetClose: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14.5, paddingVertical: 2 },
  sheetBody: { flexShrink: 1 },
  sheetFooter: { borderTopColor: colors.border, borderTopWidth: 1, paddingHorizontal: spacing.lg, paddingTop: 12 },

  chooserGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, padding: spacing.lg, paddingTop: 14 },
  chooserTile: { aspectRatio: 1, borderRadius: radius.md, overflow: 'hidden', position: 'relative', width: '31.5%' },
  chooserTileBlocked: { opacity: 0.45 },
  chooserTileImage: { height: '100%', width: '100%' },
  chooserTileEmpty: { backgroundColor: colors.surface, height: '100%', width: '100%' },
  chooserTileRing: { borderColor: colors.border, borderRadius: radius.md, borderWidth: 1, bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  chooserTileRingOn: { borderColor: colors.primary, borderWidth: 2.5 },
  chooserBadge: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 21,
    justifyContent: 'center',
    minWidth: 21,
    position: 'absolute',
    right: 6,
    top: 6,
  },
  chooserBadgeOn: { backgroundColor: colors.primary },
  chooserBadgeOff: { backgroundColor: 'rgba(255,255,255,0.9)', borderColor: colors.borderStrong, borderWidth: 1.5 },
  chooserBadgeText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 11.5 },
  chooserFooter: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  chooserFooterCopy: { flex: 1 },
  chooserFooterTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 13 },
  chooserFooterHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, marginTop: 2 },
  chooserUseButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  chooserUseButtonText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 14 },

  asideList: { gap: 10, padding: spacing.lg, paddingTop: 14 },
  asideEmpty: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13 },
  asideRow: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 11,
  },
  asideThumb: { borderRadius: 10, height: 54, width: 54 },
  asideThumbEmpty: { backgroundColor: colors.surface },
  asideCopy: { flex: 1, minWidth: 0 },
  asideCaption: { color: colors.ink, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 18 },
  asideDate: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, marginTop: 3 },
  bringBack: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
  },
  bringBackPressed: { opacity: 0.55 },
  bringBackText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12.5 },
  asideReassureText: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, marginTop: 4, textAlign: 'center' },
});
