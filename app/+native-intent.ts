export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (new URL(path).hostname === 'expo-sharing') {
      return '/(app)/new-memory';
    }

    return path;
  } catch {
    return '/';
  }
}
