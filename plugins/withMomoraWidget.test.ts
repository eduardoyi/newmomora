// Config plugins run in Node during prebuild, so these tests import the
// CommonJS helper directly instead of loading the React Native application.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { configureMomoraWidgetManifest } = require('./withMomoraWidget');

describe('configureMomoraWidgetManifest', () => {
  it('adds the non-resizable Glance receiver and clock/reboot hooks once', () => {
    const manifest = {
      manifest: {
        'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }],
        application: [{
          receiver: [{
            $: { 'android:name': '.ExistingReceiver', 'android:exported': 'false' },
          }],
        }],
      },
    };

    configureMomoraWidgetManifest(manifest);

    const root = manifest.manifest;
    expect(root['uses-permission']).toEqual(expect.arrayContaining([
      { $: { 'android:name': 'android.permission.INTERNET' } },
      { $: { 'android:name': 'android.permission.RECEIVE_BOOT_COMPLETED' } },
    ]));
    const receivers = root.application[0].receiver;
    const widget = receivers.find((receiver: { $?: { 'android:name'?: string } }) => receiver.$?.['android:name'] === 'expo.modules.momorawidget.MomoraWidgetReceiver');
    expect(widget.$).toEqual(expect.objectContaining({
      'android:exported': 'true',
    }));
    expect(widget['meta-data']).toEqual(expect.arrayContaining([
      { $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/momora_widget_info' } },
    ]));
    const system = receivers.find((receiver: { $?: { 'android:name'?: string } }) => receiver.$?.['android:name'] === 'expo.modules.momorawidget.MomoraWidgetSystemReceiver');
    const actions = system['intent-filter'][0].action.map((action: { $: { 'android:name': string } }) => action.$['android:name']);
    expect(actions).toEqual(expect.arrayContaining([
      'android.intent.action.TIME_SET',
      'android.intent.action.TIMEZONE_CHANGED',
      'android.intent.action.BOOT_COMPLETED',
    ]));
  });

  it('is idempotent and preserves unrelated receivers/permissions', () => {
    const manifest = {
      manifest: {
        'uses-permission': [{ $: { 'android:name': 'android.permission.RECEIVE_BOOT_COMPLETED' } }],
        application: [{ receiver: [] }],
      },
    };

    configureMomoraWidgetManifest(manifest);
    configureMomoraWidgetManifest(manifest);

    expect(manifest.manifest['uses-permission']).toHaveLength(1);
    expect(manifest.manifest.application[0].receiver.filter((receiver: { $?: { 'android:name'?: string } }) => receiver.$?.['android:name'] === 'expo.modules.momorawidget.MomoraWidgetReceiver')).toHaveLength(1);
    expect(manifest.manifest.application[0].receiver.filter((receiver: { $?: { 'android:name'?: string } }) => receiver.$?.['android:name'] === 'expo.modules.momorawidget.MomoraWidgetSystemReceiver')).toHaveLength(1);
  });
});

// EAS signs before native generation: both groups must be visible in app config.
describe('iOS signing configuration', () => {
  it('preserves sharing and widget groups alongside the existing Apple capability', () => {
    const { expo } = require('../app.json');
    expect(expo.ios.entitlements['com.apple.security.application-groups']).toEqual([
      'group.com.memora.app.shared',
      'group.com.memora.app.widgets',
    ]);
    expect(expo.ios.entitlements['com.apple.developer.applesignin']).toEqual(['Default']);
  });
});
