import { Alert, Linking } from 'react-native';

export interface NativePermissionResponse {
  granted: boolean;
  canAskAgain?: boolean;
}

interface NativePermissionResult<TPermission extends NativePermissionResponse> {
  permission: TPermission;
  didRequest: boolean;
}

const NATIVE_PRESENTATION_SETTLE_MS = 300;

export async function getOrRequestNativePermission<
  TPermission extends NativePermissionResponse,
>(
  getPermission: () => Promise<TPermission>,
  requestPermission: () => Promise<TPermission>,
): Promise<NativePermissionResult<TPermission>> {
  const currentPermission = await getPermission();

  if (currentPermission.granted || currentPermission.canAskAgain === false) {
    return { permission: currentPermission, didRequest: false };
  }

  return {
    permission: await requestPermission(),
    didRequest: true,
  };
}

export async function waitForNativePresentationToSettle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, NATIVE_PRESENTATION_SETTLE_MS);
  });
}

export function runAfterNativeChooserDismisses(action: () => void): void {
  setTimeout(action, NATIVE_PRESENTATION_SETTLE_MS);
}

export type NativePermissionKind = 'camera' | 'microphone' | 'photos';

const PERMISSION_COPY: Record<NativePermissionKind, { title: string; thing: string }> = {
  camera: { title: 'Turn on camera access', thing: 'your camera' },
  microphone: { title: 'Turn on microphone access', thing: 'your microphone' },
  photos: { title: 'Turn on photo access', thing: 'access to your photos' },
};

/**
 * Shown when the OS will never ask again (`canAskAgain === false`): the only
 * path left is the system Settings page. `purpose` completes "Momora needs
 * <thing> ..." (e.g. "to take photos for this memory").
 */
export function showPermissionSettingsPrompt(kind: NativePermissionKind, purpose: string): void {
  const { title, thing } = PERMISSION_COPY[kind];
  Alert.alert(title, `Momora needs ${thing} ${purpose}. You can turn it on in Settings.`, [
    { text: 'Not now', style: 'cancel' },
    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
  ]);
}

/** Inline text for a soft denial (`canAskAgain !== false`): the OS can still ask. */
export function getSoftPermissionDeniedText(kind: NativePermissionKind, purpose: string): string {
  return `Momora needs ${PERMISSION_COPY[kind].thing} ${purpose}. Tap again to allow it.`;
}
