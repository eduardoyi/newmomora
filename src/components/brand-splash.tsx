import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';

// Must match `imageWidth` on the expo-splash-screen plugin in app.json, so the
// hand-off from the native launch screen is pixel-identical (same file, same
// size, same centre). See scripts/generate-app-icons.py.
export const SPLASH_IMAGE_WIDTH = 200;
// The ivory album paper behind the photo-corner mark (scripts/generate-app-icons.py
// PAPER); matches the plugin's backgroundColor in app.json.
export const SPLASH_BACKGROUND = '#F5EFE6';

// Delay before the spinner appears, so a normal cold start (restore + auth +
// family in well under a second) reads as one continuous launch screen.
// Only a slow network ever shows the spinner.
const SPINNER_DELAY_MS = 1200;

/**
 * Continues the native launch screen while the app boots: cache restore
 * (query-persistence RestoreGate) and the post-auth router's loading states
 * (app/index.tsx). Without it, the native splash cut to a white spinner
 * screen before the Timeline appeared.
 */
export function BrandSplash() {
  const [showSpinner, setShowSpinner] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.root} testID="brand-splash">
      <StatusBar style="dark" />
      <Image
        accessibilityLabel="Momora"
        contentFit="contain"
        source={require('../../assets/images/splash-icon.png')}
        style={styles.logo}
      />
      {showSpinner ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: SPLASH_BACKGROUND,
    justifyContent: 'center',
  },
  logo: {
    height: SPLASH_IMAGE_WIDTH,
    width: SPLASH_IMAGE_WIDTH,
  },
  spinner: {
    bottom: '22%',
    position: 'absolute',
  },
});
