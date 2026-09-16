import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useMemoryWidgetSync } from '@/hooks/useMemoryWidgetSync';

function platformInstructions(): { title: string; steps: string[] } {
  if (Platform.OS === 'ios') {
    return {
      title: 'Add it on iPhone',
      steps: [
        'Touch and hold an empty place on your Home Screen.',
        'Tap Edit, select Add Widget, search Momora and add the widget.',
        'Tap and hold the widget to drag it to the place you prefer.',
      ],
    };
  }
  if (Platform.OS === 'android') {
    return {
      title: 'Add it on Android',
      steps: [
        'Touch and hold an empty place on your Home Screen.',
        'Tap Widgets, find Momora, choose the widget, and tap Add',
        'Tap and hold the widget to drag it to the place you prefer',
      ],
    };
  }
  return {
    title: 'Add it on your phone',
    steps: ['Open your phone Home Screen, then use its widget picker to add Momora.'],
  };
}

export function WidgetSetupScreen() {
  const { isSupported, isLoading, syncNow } = useMemoryWidgetSync();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const instructions = platformInstructions();

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const result = await syncNow({ showAnother: true });
      if (!result.published && result.reason !== 'not_ready') {
        Alert.alert('Widget refresh delayed', 'Momora could not refresh right now. Please try again shortly.');
      }
    } catch {
      Alert.alert('Widget refresh delayed', 'Momora could not refresh right now. Please try again shortly.');
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        testID="widget-setup-scroll"
      >
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
            testID="widget-settings-back"
          >
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
          <Text style={styles.title}>Home-screen widget</Text>
          <Text style={styles.subtitle}>
            Enjoy photos and illustrations from your family on your Home Screen.
          </Text>
        </View>

        <View style={styles.instructions}>
          <Text style={styles.sectionTitle}>{instructions.title}</Text>
          {instructions.steps.map((step, index) => (
            <View key={step} style={styles.step}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{index + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        {!isSupported && (
          <Text style={styles.notice} testID="widget-unsupported-message">
            Widgets are not available in this build. Update Momora to use this feature.
          </Text>
        )}

        <Pressable
          accessibilityRole="button"
          disabled={isRefreshing || isLoading || !isSupported}
          onPress={() => void handleRefresh()}
          style={({ pressed }) => [
            styles.refreshButton,
            (isRefreshing || isLoading || !isSupported) && styles.refreshButtonDisabled,
            pressed && !(isRefreshing || isLoading || !isSupported) && styles.refreshButtonPressed,
          ]}
          testID="widget-refresh-button"
        >
          {isRefreshing ? <ActivityIndicator color={colors.white} size="small" /> : null}
          <Text style={styles.refreshButtonText}>Show another memory</Text>
        </Pressable>
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
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 34,
  },
  subtitle: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
  },
  instructions: {
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.ink,
    fontFamily: fonts.displayMedium,
    fontSize: 20,
  },
  step: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
  },
  stepNumber: {
    alignItems: 'center',
    backgroundColor: colors.primaryTint,
    borderRadius: radius.pill,
    height: 26,
    justifyContent: 'center',
    width: 26,
  },
  stepNumberText: {
    color: colors.primaryDark,
    fontFamily: fonts.sansBold,
    fontSize: 12,
  },
  stepText: {
    color: colors.ink2,
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    paddingTop: 2,
  },
  notice: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    padding: spacing.sm,
  },
  refreshButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 50,
    paddingVertical: 16,
    width: '100%',
  },
  refreshButtonDisabled: {
    opacity: 0.55,
  },
  refreshButtonPressed: {
    backgroundColor: colors.primaryDark,
  },
  refreshButtonText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
});
