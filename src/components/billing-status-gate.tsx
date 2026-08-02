import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { colors, fonts } from '@/constants/theme';

interface BillingStatusGateProps {
  onRetry: () => Promise<void>;
}

/**
 * Fail-closed front-door state. A family must not be sent to the journal
 * while the server has failed to answer whether its owner can write.
 */
export function BillingStatusGate({ onRetry }: BillingStatusGateProps) {
  const [isRetrying, setIsRetrying] = useState(false);

  const retry = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <View style={styles.root} testID="billing-status-gate">
      <Text style={styles.title}>We couldn’t verify your subscription.</Text>
      <Text style={styles.body}>Check your connection and try again before opening your journal.</Text>
      <OnbButton
        label={isRetrying ? 'Checking…' : 'Try again'}
        onPress={() => void retry()}
        disabled={isRetrying}
        size="md"
        testID="billing-status-gate-retry"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.displayMedium,
    fontSize: 24,
    textAlign: 'center',
  },
  body: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 12,
    maxWidth: 320,
    textAlign: 'center',
  },
});
