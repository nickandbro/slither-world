import type { PelletSnapshot } from '@game/types'
import type { MutableRefObject } from 'react'

export const rebuildPelletsArray = (
  pelletMap: Map<number, PelletSnapshot>,
  pelletsArrayRef: MutableRefObject<PelletSnapshot[]>,
): PelletSnapshot[] => {
  const pellets = Array.from(pelletMap.values())
  pellets.sort((a, b) => a.id - b.id)
  pelletsArrayRef.current = pellets
  return pellets
}

export const applyPelletsToSnapshotBuffer = (
  snapshots: Array<{ pellets: PelletSnapshot[] }>,
  pellets: PelletSnapshot[],
  strategy: 'all' | 'latest' = 'latest',
): void => {
  if (snapshots.length <= 0) return
  if (strategy === 'all') {
    for (const snapshot of snapshots) {
      snapshot.pellets = pellets
    }
    return
  }
  snapshots[snapshots.length - 1].pellets = pellets
}
