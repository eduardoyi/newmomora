import { createWidget } from 'expo-widgets';
import { Image, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  aspectRatio,
  background,
  clipShape,
  clipped,
  containerRelativeFrame,
  font,
  foregroundStyle,
  lineLimit,
  padding,
  resizable,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';

export interface MomoraMemoryWidgetProps {
  kind: 'memory' | 'neutral';
  /** Neutral cards only: a verified empty family vs. nothing fresh cached. */
  emptyState?: 'no_memories' | 'needs_refresh';
  imageKind?: 'photo' | 'illustration';
  familyId?: string;
  memoryId?: string;
  mediaIndex?: number;
  expiresAt?: string;
  dateLabel?: string;
  excerpt?: string;
  imageUri?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  deepLink?: string;
}

/**
 * iOS widget layout. The Expo widget extension runs this synchronously in an
 * isolated process, so it only consumes already-installed local files and
 * primitive props. It never imports React Native hooks, Supabase, or auth.
 */
export const MomoraMemoryWidget = createWidget<MomoraMemoryWidgetProps>(
  'MomoraMemoryWidget',
  (props) => {
    'widget';

    const expiresAt = props.expiresAt ? Date.parse(props.expiresAt) : Number.NaN;
    const isMemory = props.kind === 'memory'
      && Boolean(props.imageUri)
      && (props.imageKind === 'photo' || props.imageKind === 'illustration')
      && Number.isFinite(expiresAt)
      && Date.now() < expiresAt;
    const backgroundColor = isMemory ? (props.backgroundColor ?? '#F2EFF8') : '#FBEFF3';
    const foregroundColor = isMemory ? (props.foregroundColor ?? '#2C2418') : '#2C2418';
    const hasNoMemories = !isMemory && props.kind === 'neutral' && props.emptyState === 'no_memories';
    const title = hasNoMemories ? 'Your memories will live here' : 'Your memories are waiting';
    const excerpt = isMemory
      ? (props.excerpt || 'A family memory')
      : hasNoMemories
        ? 'Add a photo or illustrated moment to see it here.'
        : "Tap to catch up on your family's moments.";
    const dateLabel = props.dateLabel || 'Your memories';
    const deepLink = isMemory ? (props.deepLink ?? 'momora://widget') : 'momora://widget';
    const label = isMemory ? `${dateLabel}: ${excerpt}` : `${title}. ${excerpt}`;
    const outerModifiers = [
      containerRelativeFrame({ axes: 'both' }),
      background(backgroundColor),
      clipShape('roundedRectangle', 20),
      widgetURL(deepLink),
      accessibilityElement('combine'),
      accessibilityLabel(label),
    ];

    if (isMemory && props.imageUri) {
      return (
        <ZStack alignment="center" modifiers={outerModifiers}>
          <Image
            uiImage={props.imageUri}
            modifiers={[
              resizable(),
              aspectRatio({ contentMode: 'fill' }),
              containerRelativeFrame({ axes: 'both' }),
              clipped(),
            ]}
          />
        </ZStack>
      );
    }

    return (
      <VStack alignment="center" spacing={6} modifiers={[padding({ all: 14 }), ...outerModifiers]}>
        <Text modifiers={[foregroundStyle('#D63E78'), font({ size: 13, weight: 'bold' }), lineLimit(1)]}>
          momora.
        </Text>
        <Text modifiers={[foregroundStyle(foregroundColor), font({ size: 16, weight: 'bold', design: 'serif' }), lineLimit(2)]}>
          {title}
        </Text>
        <Text modifiers={[foregroundStyle('#6B5E57'), font({ size: 12 }), lineLimit(3)]}>
          {excerpt}
        </Text>
      </VStack>
    );
  },
);

export default MomoraMemoryWidget;
