import type { KeyboardMetrics } from 'react-native';

import { getKeyboardTop } from '@/components/keyboard-aware-form-screen';

const metrics: KeyboardMetrics = {
  height: 300,
  screenX: 0,
  screenY: 430,
  width: 400,
};

describe('getKeyboardTop', () => {
  it('uses the Android keyboard screen coordinate when system bars make height subtraction inaccurate', () => {
    expect(getKeyboardTop(metrics, 'android', 800)).toBe(430);
  });

  it('keeps the existing height-based calculation on iOS', () => {
    expect(getKeyboardTop(metrics, 'ios', 800)).toBe(500);
  });
});
