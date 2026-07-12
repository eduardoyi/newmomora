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
