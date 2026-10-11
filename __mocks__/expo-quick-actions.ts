// Global Jest stand-in for expo-quick-actions (mapped in jest.config.js).
// The real module reads a native module at import. Tests drive launches with
// `__triggerQuickAction` and set `__setInitial` before the subscriber mounts.
import { jest } from '@jest/globals';

type Action = { id: string; title: string; icon?: string | null };

let listeners: ((action: Action) => void)[] = [];

export let initial: Action | undefined;
export const maxCount = 4;
export const setItems = jest.fn(async (_items?: Action[]) => {});
export const isSupported = jest.fn(async () => true);

export function addListener(listener: (action: Action) => void) {
  listeners.push(listener);
  return { remove: () => { listeners = listeners.filter((l) => l !== listener); } };
}

export function __setInitial(action: Action | undefined) {
  initial = action;
}

export function __triggerQuickAction(action: Action) {
  listeners.forEach((listener) => listener(action));
}

export function __resetQuickActionsMock() {
  listeners = [];
  initial = undefined;
  setItems.mockClear();
}
