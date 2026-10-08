// The family's REAL holiday card front (the one they designed in the shop
// editor), drawn natively: a React Native port of the print layout so a
// thumbnail in "Your keepsakes" / "Make something" looks like the card that
// prints -- the chosen cover (full-bleed or bordered), its focal crop, the
// greeting and small line, where the greeting sits, landscape or portrait.
//
// All the geometry lives in `src/utils/holiday-card-front.ts` (with pointers to
// the book-renderer sources it ports); this file only draws it. The trim is
// rendered (no bleed) and everything scales from `width`:
//   px per mm = width / trim width (177.8 mm landscape, 127 mm portrait).
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { fonts } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { KeepsakesCardFront } from '@/services/keepsakes';
import {
  buildHolidayCardFrontLayout,
  CARD_FRONT_STYLE,
  focalToContentPosition,
  holidayCardFrontSize,
  SCRIM_COLORS,
  SCRIM_LOCATIONS,
  type BorderedFrontLayout,
  type FullBleedFrontLayout,
} from '@/utils/holiday-card-front';
import { mediaImageSource } from '@/utils/media-image-source';

export { holidayCardFrontSize };

const IMAGE_WASH = ['#F7E3C8', '#F1CDB4'] as const;

export interface HolidayCardFrontProps {
  front: KeepsakesCardFront;
  /** The rendered width in px; the height follows the card's orientation. */
  width: number;
  testID?: string;
}

function Picture({
  front,
  rect,
  testID,
}: {
  front: KeepsakesCardFront;
  rect: { x: number; y: number; w: number; h: number };
  testID?: string;
}) {
  const { url } = useMediaUrl(front.image_key);
  const frame = { position: 'absolute' as const, left: rect.x, top: rect.y, width: rect.w, height: rect.h };
  if (url && front.image_key) {
    return (
      <Image
        cachePolicy="disk"
        contentFit="cover"
        contentPosition={focalToContentPosition(front.focal)}
        source={mediaImageSource(url, front.image_key)}
        style={frame}
        testID={testID ? `${testID}-image` : undefined}
      />
    );
  }
  return (
    <LinearGradient
      colors={IMAGE_WASH}
      end={{ x: 0.5, y: 1 }}
      pointerEvents="none"
      start={{ x: 0.5, y: 0 }}
      style={frame}
      testID={testID ? `${testID}-wash` : undefined}
    />
  );
}

function FullBleedText({ layout, testID }: { layout: FullBleedFrontLayout; testID?: string }) {
  const { text } = layout;
  const alignItems = layout.align === 'left' ? 'flex-start' : layout.align === 'right' ? 'flex-end' : 'center';
  const textAlign = layout.align;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.block,
        { alignItems, left: layout.marginPx, right: layout.marginPx },
        layout.edge === 'top' ? { top: layout.marginPx } : { bottom: layout.marginPx },
      ]}
    >
      <Text
        adjustsFontSizeToFit
        minimumFontScale={0.5}
        numberOfLines={1}
        style={[
          styles.greeting,
          {
            color: CARD_FRONT_STYLE.light,
            fontSize: text.greetingFontPx,
            lineHeight: text.greetingLinePx,
            textAlign,
          },
        ]}
        testID={testID ? `${testID}-greeting` : undefined}
      >
        {layout.greeting}
      </Text>
      {layout.subline !== null ? (
        <Text
          numberOfLines={1}
          style={[
            styles.subline,
            {
              color: CARD_FRONT_STYLE.lightSoft,
              fontSize: text.sublineFontPx,
              letterSpacing: text.sublineSpacingPx,
              lineHeight: text.sublineLinePx,
              marginTop: layout.gapPx,
              textAlign,
            },
          ]}
          testID={testID ? `${testID}-subline` : undefined}
        >
          {layout.subline}
        </Text>
      ) : null}
    </View>
  );
}

function BorderedText({ layout, testID }: { layout: BorderedFrontLayout; testID?: string }) {
  const { text } = layout;
  return (
    <View
      pointerEvents="none"
      style={[styles.row, { bottom: layout.rowBottomPx, columnGap: layout.gapPx, height: layout.rowHeightPx }]}
    >
      <Text
        numberOfLines={1}
        style={[
          styles.greeting,
          { color: CARD_FRONT_STYLE.accentInk, fontSize: text.greetingFontPx, lineHeight: text.greetingLinePx },
        ]}
        testID={testID ? `${testID}-greeting` : undefined}
      >
        {layout.greeting}
      </Text>
      {layout.subline !== null ? (
        <Text
          numberOfLines={1}
          style={[
            styles.subline,
            {
              color: CARD_FRONT_STYLE.accent,
              fontSize: text.sublineFontPx,
              letterSpacing: text.sublineSpacingPx,
              lineHeight: text.sublineLinePx,
            },
          ]}
          testID={testID ? `${testID}-subline` : undefined}
        >
          {layout.subline}
        </Text>
      ) : null}
    </View>
  );
}

export function HolidayCardFront({ front, width, testID }: HolidayCardFrontProps) {
  const layout = buildHolidayCardFrontLayout(front, width);
  const fullBleed = layout.kind === 'full-bleed';

  return (
    <View
      style={[styles.shadow, { width: layout.width, height: layout.height, borderRadius: 2 }]}
      testID={testID}
    >
      <View
        style={[
          styles.paper,
          { backgroundColor: fullBleed ? '#000000' : CARD_FRONT_STYLE.paper, borderRadius: 2 },
        ]}
      >
        <Picture front={front} rect={layout.image} testID={testID} />
        {layout.kind === 'full-bleed' ? (
          <>
            <LinearGradient
              colors={SCRIM_COLORS}
              end={{ x: 0.5, y: layout.scrim.edge === 'top' ? 1 : 0 }}
              locations={SCRIM_LOCATIONS}
              pointerEvents="none"
              start={{ x: 0.5, y: layout.scrim.edge === 'top' ? 0 : 1 }}
              style={[
                styles.scrim,
                { height: layout.scrim.heightPx },
                layout.scrim.edge === 'top' ? { top: 0 } : { bottom: 0 },
              ]}
              testID={testID ? `${testID}-scrim` : undefined}
            />
            <FullBleedText layout={layout} testID={testID} />
          </>
        ) : (
          <BorderedText layout={layout} testID={testID} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // One soft shadow on the card (the wrapper stays unclipped so it shows).
  shadow: {
    backgroundColor: CARD_FRONT_STYLE.paper,
    elevation: 4,
    shadowColor: '#2C2418',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
  },
  paper: { flex: 1, overflow: 'hidden' },
  scrim: { left: 0, position: 'absolute', right: 0 },
  block: { position: 'absolute' },
  row: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  greeting: { fontFamily: fonts.displayItalic, includeFontPadding: false },
  subline: { fontFamily: fonts.sansBold, includeFontPadding: false, textTransform: 'uppercase' },
});
