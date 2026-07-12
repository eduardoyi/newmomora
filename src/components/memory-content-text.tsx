import { Alert, Linking, StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { colors } from '@/constants/theme';
import { linkLabel, splitContentIntoSegments, type LinkPreviewMap } from '@/utils/links';

interface MemoryContentTextProps {
  content: string | null | undefined;
  linkPreviews: LinkPreviewMap | null | undefined;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

/** Re-validated at press time -- defense in depth even though extraction only ever matches http(s). */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Opens `url` in the phone's default browser -- never an in-app browser
 * (docs/plans/inline-links.md §6). Never fails silently: a rejected
 * `Linking.openURL` (or a scheme that fails the re-check) surfaces an
 * alert rather than doing nothing.
 */
export async function openLink(url: string): Promise<void> {
  if (!isOpenableUrl(url)) {
    Alert.alert('Could not open link');
    return;
  }

  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert('Could not open link');
  }
}

/**
 * Spoofing mitigation: the rendered label is a third-party-controlled page
 * title and hides the real destination, so long-press always lets the user
 * inspect the full URL before deciding to open it.
 */
export function revealUrl(url: string): void {
  Alert.alert('Link destination', url, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open', onPress: () => void openLink(url) },
  ]);
}

/**
 * Renders memory `content` as flowing text with pasted URLs rendered as
 * `(Title)` / `(domain)` inline links -- the editor itself stays plain text
 * (RN TextInput); this component is for rendered (non-editing) views only.
 */
export function MemoryContentText({ content, linkPreviews, style, testID }: MemoryContentTextProps) {
  const segments = splitContentIntoSegments(content);

  return (
    <Text style={style} testID={testID}>
      {segments.map((segment, index) =>
        segment.type === 'link' ? (
          <Text
            key={`link-${index}-${segment.url}`}
            accessibilityRole="link"
            style={styles.link}
            suppressHighlighting
            onPress={() => void openLink(segment.url)}
            onLongPress={() => revealUrl(segment.url)}
            testID={testID ? `${testID}-link-${index}` : undefined}
          >
            {`(${linkLabel(segment.url, linkPreviews)})`}
          </Text>
        ) : (
          <Text key={`text-${index}`}>{segment.text}</Text>
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: {
    color: colors.sea,
  },
});
