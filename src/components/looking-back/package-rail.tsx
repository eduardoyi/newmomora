import { memo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';
import { LookingBackPackageCard, type LookingBackPackageCardData } from '@/components/looking-back/package-card';

export const LookingBackPackageRail = memo(function LookingBackPackageRail({
  packages,
  onOpen,
}: {
  packages: LookingBackPackageCardData[];
  onOpen: (packageId: string, sourceGeometry: { x: number; y: number; width: number; height: number; windowWidth: number; windowHeight: number } | null) => void;
}) {
  if (packages.length === 0) return null;
  return (
    <View style={styles.wrap} testID="looking-back-rail">
      <View style={styles.labelRow}>
        <Text style={styles.label}>Looking back</Text>
        <View style={styles.rule} />
      </View>
      <FlatList
        contentContainerStyle={styles.content}
        data={packages}
        decelerationRate="fast"
        horizontal
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <LookingBackPackageCard item={item} onPress={(geometry) => onOpen(item.id, geometry)} />}
        showsHorizontalScrollIndicator={false}
        snapToInterval={180}
        testID="looking-back-package-list"
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { marginTop: 0 },
  labelRow: { alignItems: 'center', flexDirection: 'row', gap: 9, paddingHorizontal: 24 },
  label: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10.5, letterSpacing: 1.4, textTransform: 'uppercase' },
  rule: { backgroundColor: colors.border, flex: 1, height: 1 },
  content: { gap: 12, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 14 },
});
