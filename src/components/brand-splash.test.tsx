import { render, waitFor } from '@testing-library/react-native';
import { ActivityIndicator } from 'react-native';

import appJson from '../../app.json';
import { BrandSplash, SPLASH_BACKGROUND, SPLASH_IMAGE_WIDTH } from './brand-splash';

describe('BrandSplash', () => {
  it('matches the native launch screen size in app.json', () => {
    const plugin = appJson.expo.plugins.find(
      (entry): entry is [string, { imageWidth?: number; backgroundColor?: string }] =>
        Array.isArray(entry) && entry[0] === 'expo-splash-screen',
    );
    expect(plugin?.[1].imageWidth).toBe(SPLASH_IMAGE_WIDTH);
    expect(plugin?.[1].backgroundColor).toBe(SPLASH_BACKGROUND);
  });

  // Real timers: rendering this tree under jest fake timers hangs the worker.
  it('shows the spinner only once boot runs long', async () => {
    const screen = render(<BrandSplash />);
    expect(screen.getByTestId('brand-splash')).toBeTruthy();
    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();

    await waitFor(() => expect(screen.UNSAFE_queryByType(ActivityIndicator)).not.toBeNull(), { timeout: 3000 });
  });
});
