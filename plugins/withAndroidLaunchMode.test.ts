// The config plugin executes in Node during Expo prebuild, so its unit test
// imports the CommonJS module directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { configureMainActivityLaunchBehavior } = require('./withAndroidLaunchMode');

describe('configureMainActivityLaunchBehavior', () => {
  it('reuses the top activity and refuses gallery document tasks', () => {
    const manifest = {
      manifest: {
        application: [{
          activity: [{
            $: {
              'android:name': '.MainActivity',
              'android:launchMode': 'standard',
              'android:exported': 'true',
            },
            'intent-filter': [{
              action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
            }],
          }],
        }],
      },
    };

    configureMainActivityLaunchBehavior(manifest);

    expect(manifest.manifest.application[0].activity[0].$).toEqual({
      'android:name': '.MainActivity',
      'android:launchMode': 'singleTop',
      'android:documentLaunchMode': 'never',
      'android:exported': 'true',
    });
    expect(manifest.manifest.application[0].activity[0]['intent-filter']).toEqual([{
      action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
    }]);
  });

  it('fails closed when Expo has no main activity to configure', () => {
    expect(() => configureMainActivityLaunchBehavior({
      manifest: { application: [{ activity: [] }] },
    })).toThrow('AndroidManifest.xml is missing the Expo main activity.');
  });
});
