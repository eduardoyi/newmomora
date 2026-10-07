// The holiday card as a physical object (docs/plans/keepsakes-redesign.md
// C1/C5/D3): a white 5:7 card front -- the family's own picture on top, the
// greeting and a tiny family line below -- tilted -1.5 degrees, with a kraft
// envelope peeking out behind it at the top right (tilted +1.5 degrees). One
// soft shadow, no tape. Shared by the storefront card, the shelf and the card
// product page, so it scales everything from `width`.
//
// OUTER SIZE (the layout box this component occupies, before the small tilt):
//   width  = 1.27 * width   (the card is `width` wide; the envelope sticks out
//                            0.27 * width to its right)
//   height = 1.54 * width   (the card is 1.4 * width tall; the envelope sticks
//                            out 0.14 * width above it)
// The -1.5 / +1.5 degree tilts spill at most ~0.04 * width past that box; the
// box itself is not clipped.
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { mediaImageSource } from '@/utils/media-image-source';

export const HOLIDAY_CARD_OUTER_WIDTH_RATIO = 1.27;
export const HOLIDAY_CARD_OUTER_HEIGHT_RATIO = 1.54;
const CARD_HEIGHT_RATIO = 1.4; // 5:7
const ENVELOPE_TOP_RATIO = 0;
const CARD_TOP_RATIO = 0.14;
const ENVELOPE_LEFT_RATIO = 0.27;
const PADDING_RATIO = 0.06;
// The picture takes the top ~70% of the card (padding included).
const IMAGE_HEIGHT_RATIO = 0.9;

const ENVELOPE_BODY = '#F3EEE6';
const ENVELOPE_BORDER = '#E6DED2';
const ENVELOPE_FLAP = '#E8E0D3';
const IMAGE_WASH = ['#F7E3C8', '#F1CDB4'] as const;

export function holidayCardObjectSize(width: number): { width: number; height: number } {
  return {
    width: Math.round(width * HOLIDAY_CARD_OUTER_WIDTH_RATIO),
    height: Math.round(width * HOLIDAY_CARD_OUTER_HEIGHT_RATIO),
  };
}

/**
 * "Tomás · 2026", "Tomás & Lucía · 2026", "A, B & C · 2026". Blank names are
 * dropped; with no names left it is just the year.
 */
export function holidayCardFamilyLine(names: string[], year: number): string {
  const cleaned = names.map((name) => name.trim()).filter((name) => name.length > 0);
  if (cleaned.length === 0) return String(year);
  const joined =
    cleaned.length === 1
      ? cleaned[0]!
      : `${cleaned.slice(0, -1).join(', ')} & ${cleaned[cleaned.length - 1]!}`;
  return `${joined} · ${year}`;
}

export interface HolidayCardObjectProps {
  /** The card's width; the outer box is ~1.27x wide and ~1.54x tall (see the file header). */
  width: number;
  /** R2 key of the picture (the overview's `preview_key`); null renders a warm wash. */
  imageKey: string | null;
  /** From `holidayCardFamilyLine`. */
  familyLine: string;
  /** Defaults to "Happy holidays". */
  greeting?: string;
  testID?: string;
}

export function HolidayCardObject({
  width,
  imageKey,
  familyLine,
  greeting = 'Happy holidays',
  testID,
}: HolidayCardObjectProps) {
  const { url } = useMediaUrl(imageKey);
  const outer = holidayCardObjectSize(width);
  const cardHeight = Math.round(width * CARD_HEIGHT_RATIO);
  const padding = Math.round(width * PADDING_RATIO);
  const imageHeight = Math.round(width * IMAGE_HEIGHT_RATIO);
  const imageWidth = width - padding * 2;
  const envelopeWidth = width;
  const envelopeHeight = Math.round(width * 1.15);
  const flapHeight = Math.round(envelopeHeight * 0.5);

  return (
    <View style={{ width: outer.width, height: outer.height }} testID={testID}>
      <View
        pointerEvents="none"
        style={[
          styles.envelope,
          {
            left: Math.round(width * ENVELOPE_LEFT_RATIO),
            top: Math.round(width * ENVELOPE_TOP_RATIO),
            width: envelopeWidth,
            height: envelopeHeight,
            borderRadius: Math.max(3, Math.round(width * 0.02)),
          },
        ]}
        testID={testID ? `${testID}-envelope` : undefined}
      >
        <View
          style={[
            styles.flap,
            {
              borderLeftWidth: envelopeWidth / 2,
              borderRightWidth: envelopeWidth / 2,
              borderTopWidth: flapHeight,
            },
          ]}
        />
      </View>

      <View
        style={[
          styles.card,
          {
            top: Math.round(width * CARD_TOP_RATIO),
            width,
            height: cardHeight,
            padding,
            borderRadius: Math.max(3, Math.round(width * 0.025)),
          },
        ]}
      >
        <View style={{ width: imageWidth, height: imageHeight, borderRadius: Math.max(2, Math.round(width * 0.015)), overflow: 'hidden' }}>
          {url && imageKey ? (
            <Image
              cachePolicy="disk"
              contentFit="cover"
              source={mediaImageSource(url, imageKey)}
              style={StyleSheet.absoluteFill}
              testID={testID ? `${testID}-image` : undefined}
            />
          ) : (
            <LinearGradient
              colors={IMAGE_WASH}
              end={{ x: 0.5, y: 1 }}
              pointerEvents="none"
              start={{ x: 0.5, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          )}
        </View>
        <View style={styles.captionBlock}>
          <Text
            adjustsFontSizeToFit
            numberOfLines={1}
            style={[styles.greeting, { fontSize: Math.round(width * 0.115), lineHeight: Math.round(width * 0.14) }]}
          >
            {greeting}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              styles.familyLine,
              { fontSize: Math.max(5, Math.round(width * 0.04 * 10) / 10), letterSpacing: Math.max(0.4, width * 0.006) },
            ]}
          >
            {familyLine.toUpperCase()}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  envelope: {
    backgroundColor: ENVELOPE_BODY,
    borderColor: ENVELOPE_BORDER,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'absolute',
    transform: [{ rotate: '1.5deg' }],
  },
  // A downward-pointing triangle (border trick) in a darker kraft.
  flap: {
    backgroundColor: 'transparent',
    borderBottomWidth: 0,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: ENVELOPE_FLAP,
    height: 0,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 0,
  },
  card: {
    backgroundColor: colors.white,
    left: 0,
    position: 'absolute',
    shadowColor: '#2C2418',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
    elevation: 4,
    transform: [{ rotate: '-1.5deg' }],
  },
  captionBlock: {
    alignItems: 'center',
    flex: 1,
    gap: 3,
    justifyContent: 'center',
  },
  greeting: {
    color: colors.ink,
    fontFamily: fonts.display,
    textAlign: 'center',
  },
  familyLine: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    textAlign: 'center',
  },
});
