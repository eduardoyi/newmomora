// The holiday card as a physical object (docs/plans/keepsakes-redesign.md
// C1/C5/D3): the card front tilted -1.5 degrees with a kraft envelope peeking
// out behind it at the top right (tilted +1.5 degrees). One soft shadow, no
// tape. Shared by the storefront card, the shelf and the card product page, so
// it scales everything from `width`.
//
// Two fronts:
//  - `front` (the family's REAL card, `keepsakes_overview.card_front`): drawn by
//    `HolidayCardFront`, landscape or portrait, with the chosen cover, crop,
//    greeting and small line.
//  - no `front` (nothing created yet, or the overview failed): a generic 5:7
//    portrait "could look like this" preview on the family's newest picture,
//    with the language's default greeting and just the year -- the real default.
//
// OUTER SIZE (the layout box this component occupies, before the small tilt;
// see `holidayCardObjectLayout`): the envelope sticks out 0.27 x the card's
// shorter side to the right and 0.14 x above. For the portrait 5:7 card that is
// 1.27 x 1.54 of `width`; a landscape card (0.714 x its width tall) is
// narrower in height. The tilts spill at most ~0.04 x past the box; the box
// itself is not clipped.
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { HolidayCardFront, holidayCardFrontSize } from '@/components/keepsakes/holiday-card-front';
import { fonts } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { KeepsakesCardFront } from '@/services/keepsakes';
import { CARD_FRONT_STYLE, holidayCardObjectLayout } from '@/utils/holiday-card-front';
import { mediaImageSource } from '@/utils/media-image-source';

const CARD_HEIGHT_RATIO = 1.4; // 5:7
const PADDING_RATIO = 0.06;
// The picture takes the top ~70% of the generic card (padding included).
const IMAGE_HEIGHT_RATIO = 0.9;

const ENVELOPE_BODY = '#F3EEE6';
const ENVELOPE_BORDER = '#E6DED2';
const ENVELOPE_FLAP = '#E8E0D3';
const IMAGE_WASH = ['#F7E3C8', '#F1CDB4'] as const;

/** The object's outer box for a PORTRAIT 5:7 card of `width` (the generic preview). */
export function holidayCardObjectSize(width: number): { width: number; height: number } {
  return holidayCardObjectLayout(width, Math.round(width * CARD_HEIGHT_RATIO)).outer;
}

/** The object's outer box for the family's real card (landscape or portrait) at `width`. */
export function holidayCardFrontObjectSize(
  front: Pick<KeepsakesCardFront, 'orientation'>,
  width: number,
): { width: number; height: number } {
  return holidayCardObjectLayout(width, holidayCardFrontSize(front, width).height).outer;
}

export interface HolidayCardObjectProps {
  /** The card's width; the outer box follows the card's shape (see the file header). */
  width: number;
  /** The family's real card; omit / null for the generic preview. */
  front?: KeepsakesCardFront | null;
  /** Generic preview only: R2 key of the picture (the overview's `preview_key`); null renders a warm wash. */
  imageKey?: string | null;
  /** Generic preview only: defaults to "Happy Holidays". */
  greeting?: string;
  /** Generic preview only: the small line (the year by default). Omit to hide. */
  subline?: string;
  testID?: string;
}

export function HolidayCardObject({
  width,
  front = null,
  imageKey = null,
  greeting = 'Happy Holidays',
  subline,
  testID,
}: HolidayCardObjectProps) {
  const { url } = useMediaUrl(front ? null : imageKey);
  const cardHeight = front ? holidayCardFrontSize(front, width).height : Math.round(width * CARD_HEIGHT_RATIO);
  const layout = holidayCardObjectLayout(width, cardHeight);
  const padding = Math.round(width * PADDING_RATIO);
  const imageHeight = Math.round(width * IMAGE_HEIGHT_RATIO);
  const imageWidth = width - padding * 2;
  const envelopeWidth = layout.envelope.width;
  const envelopeHeight = layout.envelope.height;
  const flapHeight = Math.round(envelopeHeight * 0.5);
  const unit = Math.min(width, cardHeight);

  return (
    <View style={{ width: layout.outer.width, height: layout.outer.height }} testID={testID}>
      <View
        pointerEvents="none"
        style={[
          styles.envelope,
          {
            left: layout.envelope.left,
            top: layout.envelope.top,
            width: envelopeWidth,
            height: envelopeHeight,
            borderRadius: Math.max(3, Math.round(unit * 0.02)),
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

      {front ? (
        <View
          style={[
            styles.cardSlot,
            { top: layout.card.top, width: layout.card.width, height: layout.card.height },
          ]}
        >
          <HolidayCardFront front={front} testID={testID ? `${testID}-front` : undefined} width={width} />
        </View>
      ) : (
        <View
          style={[
            styles.card,
            {
              top: layout.card.top,
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
            {subline ? (
              <Text
                numberOfLines={1}
                style={[
                  styles.subline,
                  { fontSize: Math.max(5, Math.round(width * 0.04 * 10) / 10), letterSpacing: Math.max(0.4, width * 0.012) },
                ]}
              >
                {subline}
              </Text>
            ) : null}
          </View>
        </View>
      )}
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
  cardSlot: {
    left: 0,
    position: 'absolute',
    transform: [{ rotate: '-1.5deg' }],
  },
  card: {
    backgroundColor: CARD_FRONT_STYLE.paper,
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
    color: CARD_FRONT_STYLE.accentInk,
    fontFamily: fonts.displayItalic,
    textAlign: 'center',
  },
  subline: {
    color: CARD_FRONT_STYLE.accent,
    fontFamily: fonts.sansBold,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
});
