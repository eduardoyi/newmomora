const { withAndroidManifest } = require('@expo/config-plugins');

const ALLOW_BACKUP_REPLACEMENT = 'android:allowBackup';

function addAllowBackupManifestOverride(manifest) {
  const application = manifest.manifest.application?.[0];

  if (!application) {
    throw new Error('AndroidManifest.xml is missing its application element.');
  }

  const replacements = (application.$?.['tools:replace'] ?? '')
    .split(',')
    .map((replacement) => replacement.trim())
    .filter(Boolean);

  if (!replacements.includes(ALLOW_BACKUP_REPLACEMENT)) {
    replacements.push(ALLOW_BACKUP_REPLACEMENT);
  }

  application.$ = {
    ...application.$,
    'tools:replace': replacements.join(','),
  };

  return manifest;
}

function withAndroidAllowBackup(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = addAllowBackupManifestOverride(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withAndroidAllowBackup;
module.exports.addAllowBackupManifestOverride = addAllowBackupManifestOverride;
