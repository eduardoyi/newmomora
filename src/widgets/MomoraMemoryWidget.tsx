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
    const backgroundColor = props.backgroundColor ?? '#F2EFF8';
    const foregroundColor = props.foregroundColor ?? '#2C2418';
    const excerpt = isMemory ? (props.excerpt || 'A family memory') : 'Open Momora for photo memories';
    const dateLabel = props.dateLabel || 'Your memories';
    const deepLink = isMemory ? (props.deepLink ?? 'momora://widget') : 'momora://widget';
    const label = isMemory ? `${dateLabel}: ${excerpt}` : 'Open Momora to refresh your memories';
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
      <VStack alignment="center" spacing={8} modifiers={[padding({ all: 12 }), ...outerModifiers]}>
        <Text modifiers={[foregroundStyle(foregroundColor), font({ size: 18, weight: 'bold' }), lineLimit(1)]}>
          Momora
        </Text>
        <Text modifiers={[foregroundStyle(foregroundColor), font({ size: 15, design: 'serif' }), lineLimit(5)]}>
          {excerpt}
        </Text>
      </VStack>
    );
  },
);

export default MomoraMemoryWidget;
