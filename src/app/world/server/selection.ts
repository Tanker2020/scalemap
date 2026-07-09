// src/app/world/server/selection.ts
// Type-only union of everything selectable on the Level-4 server board. Created by T3 (a pure
// type file, breaks nothing downstream) so ServerBoard/TraceLayer/StackPlate can import it before
// T6 lands the inspector rail that actually consumes selection state.
import type { InstanceId } from '../../../lib/world/types'

export type BoardSelection =
  | { kind: 'instance'; instanceId: InstanceId }
  | { kind: 'nic' }
  | { kind: 'firewall' }
  | { kind: 'rule'; ruleId: string }
  | { kind: 'stack'; stackName: string }
  | { kind: 'volume'; stackName: string; volumeName: string }
  | { kind: 'hardware'; part: 'cpu' | 'ram' | 'disk' }
  | { kind: 'core'; coreIndex: number }
