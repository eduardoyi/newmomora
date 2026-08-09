import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { LookingBackPackageWithMemories } from '@/hooks/useLookingBackPackages';

export type LookingBackPauseReason = 'manual' | 'background' | 'buffering' | 'detail' | 'screen-reader';

export interface LookingBackCheckpoint {
  familyId: string;
  dailySetId: string;
  packageId: string;
  frameIndex: number;
  frameFraction: number;
  phase: 'intro' | 'playing' | 'complete';
  isMuted: boolean;
  pauseReasons: LookingBackPauseReason[];
}
export interface LookingBackSourceGeometry {
  x: number; y: number; width: number; height: number; capturedAtMs: number;
  windowWidth: number; windowHeight: number;
}

interface LookingBackSessionValue {
  checkpoint: LookingBackCheckpoint | null;
  /** Ephemeral, in-memory only snapshot. It is deliberately never persisted
   * with the checkpoint or route params, so journal content cannot outlive
   * this authenticated app tree. */
  packageSnapshot: { packageId: string; familyId: string; dailySetId: string; sourceGeometry: LookingBackSourceGeometry | null; value: LookingBackPackageWithMemories } | null;
  saveCheckpoint: (checkpoint: LookingBackCheckpoint) => void;
  savePackageSnapshot: (value: LookingBackPackageWithMemories, sourceGeometry?: LookingBackSourceGeometry | null) => void;
  /** Keep a frozen package identity, but tombstone live-deleted/unsafe rows. */
  reconcilePackageMemories: (packageId: string, safeMemoryIds: readonly string[]) => void;
  clearCheckpoint: (packageId?: string) => void;
}

const LookingBackSessionContext = createContext<LookingBackSessionValue | null>(null);

export function LookingBackSessionProvider({ children }: { children: ReactNode }) {
  const [checkpoint, setCheckpoint] = useState<LookingBackCheckpoint | null>(null);
  const [packageSnapshot, setPackageSnapshot] = useState<{ packageId: string; familyId: string; dailySetId: string; sourceGeometry: LookingBackSourceGeometry | null; value: LookingBackPackageWithMemories } | null>(null);
  const saveCheckpoint = useCallback((nextCheckpoint: LookingBackCheckpoint) => setCheckpoint(nextCheckpoint), []);
  const reconcilePackageMemories = useCallback((packageId: string, safeMemoryIds: readonly string[]) => {
    const safeIds = new Set(safeMemoryIds);
    setPackageSnapshot((current) => {
      if (!current || current.packageId !== packageId) return current;
      const nextMemories = current.value.memories.filter((memory) => safeIds.has(memory.id));
      if (nextMemories.length === current.value.memories.length) return current;
      return {
        ...current,
        // Do not replace titles, daily-set identity, or any still-safe memory
        // from a refetch. Only remove a row that live safety says is gone.
        value: { ...current.value, memories: nextMemories },
      };
    });
  }, []);
  const clearCheckpoint = useCallback((packageId?: string) => {
    setCheckpoint((current) => !packageId || current?.packageId === packageId ? null : current);
    setPackageSnapshot((current) => !packageId || current?.packageId === packageId ? null : current);
  }, []);
  const savePackageSnapshot = useCallback((value: LookingBackPackageWithMemories, sourceGeometry: LookingBackSourceGeometry | null = null) => setPackageSnapshot({ packageId: value.id, familyId: value.familyId, dailySetId: value.dailySetId, sourceGeometry, value }), []);
  const value = useMemo(() => ({ checkpoint, packageSnapshot, saveCheckpoint, savePackageSnapshot, reconcilePackageMemories, clearCheckpoint }), [checkpoint, packageSnapshot, clearCheckpoint, reconcilePackageMemories, saveCheckpoint, savePackageSnapshot]);
  return <LookingBackSessionContext.Provider value={value}>{children}</LookingBackSessionContext.Provider>;
}

export function useLookingBackSession(): LookingBackSessionValue {
  const value = useContext(LookingBackSessionContext);
  if (!value) {
    throw new Error('useLookingBackSession must be used inside LookingBackSessionProvider');
  }
  return value;
}
