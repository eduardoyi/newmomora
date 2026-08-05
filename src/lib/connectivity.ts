import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

// Reflects device connectivity into react-query's shared `onlineManager`
// singleton. Nothing sets this today, which keeps mutations from ever
// pausing (see the `networkMode` comment in src/lib/query-client.ts) and
// keeps offline query behavior undefined -- wiring it here is the single
// foundation both O2 (banner)/O3 (reconnect refetch) and O6 (mutation
// fail-fast) build on.
//
// NetInfo.addEventListener replays the current state to a fresh listener
// immediately, so onlineManager starts correct without a separate fetch()
// call. `isInternetReachable` is `null` while NetInfo is still probing --
// treat that as online (don't flip the app offline on an inconclusive
// check), only `false` (a confirmed captive-portal/no-route case) counts as
// offline alongside `isConnected !== true`.
export function startConnectivityMonitoring(): () => void {
  return NetInfo.addEventListener((state: NetInfoState) => {
    onlineManager.setOnline(state.isConnected === true && state.isInternetReachable !== false);
  });
}

function subscribe(listener: () => void): () => void {
  return onlineManager.subscribe(listener);
}

function getSnapshot(): boolean {
  return onlineManager.isOnline();
}

// useSyncExternalStore over the existing onlineManager singleton -- no
// separate store to keep in sync. Re-renders callers whenever
// startConnectivityMonitoring's NetInfo listener (or a test calling
// onlineManager.setOnline directly) flips the online state.
export function useIsOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
