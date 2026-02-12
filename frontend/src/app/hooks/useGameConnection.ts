import { useEffect } from 'react'
import type { DependencyList } from 'react'

export function useGameConnection(
  effect: () => void | (() => void),
  deps: DependencyList,
): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(effect, deps)
}
