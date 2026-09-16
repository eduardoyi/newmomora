const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const WIDGET_RECEIVER = 'expo.modules.momorawidget.MomoraWidgetReceiver';
const SYSTEM_RECEIVER = 'expo.modules.momorawidget.MomoraWidgetSystemReceiver';
const WIDGET_META_DATA = 'android.appwidget.provider';
const WIDGET_INFO_FILE = 'momora_widget_info.xml';
const LOADING_LAYOUT_FILE = 'momora_widget_loading.xml';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function receiverName(receiver) {
  return receiver?.$?.['android:name'];
}

function configureMomoraWidgetManifest(manifest) {
  const root = manifest.manifest;
  if (!root || !root.application?.[0]) {
    throw new Error('AndroidManifest.xml is missing its application element.');
  }

  const permissionName = 'android.permission.RECEIVE_BOOT_COMPLETED';
  const permissions = ensureArray(root['uses-permission']);
  if (!permissions.some((permission) => permission?.$?.['android:name'] === permissionName)) {
    permissions.push({ $: { 'android:name': permissionName } });
  }
  root['uses-permission'] = permissions;

  const application = root.application[0];
  const receivers = ensureArray(application.receiver);
  const existingWidget = receivers.find((receiver) => receiverName(receiver) === WIDGET_RECEIVER);
  const widgetReceiver = existingWidget ?? {
    $: {
      'android:name': WIDGET_RECEIVER,
      'android:exported': 'true',
    },
  };
  widgetReceiver.$ = {
    ...widgetReceiver.$,
    'android:name': WIDGET_RECEIVER,
    'android:exported': 'true',
  };
  const widgetIntentFilters = ensureArray(widgetReceiver['intent-filter']);
  if (!widgetIntentFilters.some((filter) => filter?.action?.some((action) => action?.$?.['android:name'] === 'android.appwidget.action.APPWIDGET_UPDATE'))) {
    widgetIntentFilters.push({
      action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }],
    });
  }
  widgetReceiver['intent-filter'] = widgetIntentFilters;
  const metadata = ensureArray(widgetReceiver['meta-data']);
  const providerMetadata = metadata.find((item) => item?.$?.['android:name'] === WIDGET_META_DATA);
  const nextMetadata = providerMetadata ?? {
    $: {
      'android:name': WIDGET_META_DATA,
    },
  };
  nextMetadata.$ = {
    ...nextMetadata.$,
    'android:name': WIDGET_META_DATA,
    'android:resource': '@xml/momora_widget_info',
  };
  if (!providerMetadata) metadata.push(nextMetadata);
  widgetReceiver['meta-data'] = metadata;
  if (!existingWidget) receivers.push(widgetReceiver);

  const existingSystem = receivers.find((receiver) => receiverName(receiver) === SYSTEM_RECEIVER);
  const systemReceiver = existingSystem ?? {
    $: {
      'android:name': SYSTEM_RECEIVER,
      'android:exported': 'false',
    },
  };
  systemReceiver.$ = {
    ...systemReceiver.$,
    'android:name': SYSTEM_RECEIVER,
    'android:exported': 'false',
  };
  const systemFilters = ensureArray(systemReceiver['intent-filter']);
  const systemActions = new Set(
    systemFilters.flatMap((filter) => ensureArray(filter?.action).map((action) => action?.$?.['android:name'])),
  );
  const requiredSystemActions = [
    'android.intent.action.TIME_SET',
    'android.intent.action.TIMEZONE_CHANGED',
    'android.intent.action.BOOT_COMPLETED',
  ];
  const systemFilter = systemFilters[0] ?? { action: [] };
  systemFilter.action = ensureArray(systemFilter.action);
  for (const action of requiredSystemActions) {
    if (!systemActions.has(action)) {
      systemFilter.action.push({ $: { 'android:name': action } });
    }
  }
  systemFilters[0] = systemFilter;
  systemReceiver['intent-filter'] = systemFilters;
  if (!existingSystem) receivers.push(systemReceiver);

  application.receiver = receivers;
  return manifest;
}

function writeMomoraWidgetResources(projectRoot) {
  const resourceRoot = path.join(projectRoot, 'app', 'src', 'main', 'res');
  const xmlRoot = path.join(resourceRoot, 'xml');
  const layoutRoot = path.join(resourceRoot, 'layout');
  fs.mkdirSync(xmlRoot, { recursive: true });
  fs.mkdirSync(layoutRoot, { recursive: true });

  const widgetInfo = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="168dp"
    android:minHeight="244dp"
    android:targetCellWidth="2"
    android:targetCellHeight="3"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/${LOADING_LAYOUT_FILE.replace('.xml', '')}"
    android:resizeMode="none"
    android:widgetCategory="home_screen" />
`;
  const loadingLayout = `<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="#F2EFF8"
    android:padding="16dp">
    <TextView
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:gravity="center"
        android:text="Momora"
        android:textColor="#2C2418"
        android:textSize="18sp" />
</FrameLayout>
`;
  fs.writeFileSync(path.join(xmlRoot, WIDGET_INFO_FILE), widgetInfo);
  fs.writeFileSync(path.join(layoutRoot, LOADING_LAYOUT_FILE), loadingLayout);
  return { widgetInfoPath: path.join(xmlRoot, WIDGET_INFO_FILE), loadingLayoutPath: path.join(layoutRoot, LOADING_LAYOUT_FILE) };
}

function withMomoraWidget(config) {
  let next = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = configureMomoraWidgetManifest(modConfig.modResults);
    return modConfig;
  });
  next = withDangerousMod(next, [
    'android',
    async (modConfig) => {
      writeMomoraWidgetResources(modConfig.modRequest.platformProjectRoot);
      return modConfig;
    },
  ]);
  return next;
}

module.exports = withMomoraWidget;
module.exports.configureMomoraWidgetManifest = configureMomoraWidgetManifest;
module.exports.writeMomoraWidgetResources = writeMomoraWidgetResources;
module.exports.WIDGET_RECEIVER = WIDGET_RECEIVER;
module.exports.SYSTEM_RECEIVER = SYSTEM_RECEIVER;
