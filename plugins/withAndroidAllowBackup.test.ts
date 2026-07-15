// The config plugin executes in Node during Expo prebuild, so its unit test
// imports the CommonJS module directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addAllowBackupManifestOverride } = require('./withAndroidAllowBackup');

describe('addAllowBackupManifestOverride', () => {
  it('keeps the app backup setting when a dependency declares a different value', () => {
    const manifest = {
      manifest: {
        application: [{ $: { 'android:allowBackup': 'false' } }],
      },
    };

    addAllowBackupManifestOverride(manifest);

    expect(manifest.manifest.application[0].$).toMatchObject({
      'android:allowBackup': 'false',
      'tools:replace': 'android:allowBackup',
    });
  });

  it('preserves other manifest replacements without duplicating allowBackup', () => {
    const manifest = {
      manifest: {
        application: [{ $: { 'tools:replace': 'android:label, android:allowBackup' } }],
      },
    };

    addAllowBackupManifestOverride(manifest);

    expect(manifest.manifest.application[0].$['tools:replace'])
      .toBe('android:label,android:allowBackup');
  });
});
