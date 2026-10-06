import { useSyncExternalStore } from 'react';
import { handoffController } from './handoffRuntime';
import type { HandoffState } from './handoffController';

export function useHandoff(): HandoffState {
  return useSyncExternalStore(handoffController.subscribe, handoffController.getState, handoffController.getState);
}
