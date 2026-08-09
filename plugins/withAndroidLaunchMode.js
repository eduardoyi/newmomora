const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * RevenueCat supports standard or singleTop for Google Play verification.
 * singleTop lets Expo deliver a new share to an existing MainActivity, while
 * documentLaunchMode=never overrides gallery NEW_DOCUMENT/MULTIPLE_TASK flags
 * that would otherwise create a second ReactActivity with no usable host.
 */
function configureMainActivityLaunchBehavior(manifest) {
  const application = manifest.manifest.application?.[0];
  const activity = application?.activity?.find((candidate) => {
    const name = candidate.$?.['android:name'];
    return name === '.MainActivity' || name === 'com.memora.app.MainActivity' || name?.endsWith('.MainActivity');
  });

  if (!activity) {
    throw new Error('AndroidManifest.xml is missing the Expo main activity.');
  }

  activity.$ = {
    ...activity.$,
    'android:launchMode': 'singleTop',
    'android:documentLaunchMode': 'never',
  };
  return manifest;
}

function withAndroidLaunchMode(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = configureMainActivityLaunchBehavior(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withAndroidLaunchMode;
module.exports.configureMainActivityLaunchBehavior = configureMainActivityLaunchBehavior;
