// Lives in app/ (not lib/world/) deliberately: lib/ must never import app stores.
import { useMemo } from 'react'
import { useWorldStore } from '../store/world.store'
import { compileWorld } from '../../lib/world/compileWorld'

export function useCompiledWorld() {
  const doc = useWorldStore(s => s.doc)
  return useMemo(() => compileWorld(doc), [doc])
}
