const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * RevenueCat's Google Play purchase verification requires the main activity
 * not to use singleTask.  standard also preserves the existing deep-link,
 * OTP, and notification intent behaviour under Expo Router.
 */
function withAndroidLaunchMode(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    const activity = application?.activity?.find((candidate) => {
      const name = candidate.$?.['android:name'];
      return name === '.MainActivity' || name === 'com.memora.app.MainActivity' || name?.endsWith('.MainActivity');
    });

    if (!activity) {
      throw new Error('AndroidManifest.xml is missing the Expo main activity.');
    }

    activity.$ = {
      ...activity.$,
      'android:launchMode': 'standard',
    };
    return modConfig;
  });
}

module.exports = withAndroidLaunchMode;
