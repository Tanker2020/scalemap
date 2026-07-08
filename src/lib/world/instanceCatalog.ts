import type { ServerKind, ServerSpecs } from './types'

export interface InstancePreset {
  id: string
  label: string
  kind: ServerKind
  specs: ServerSpecs
  hourlyUsd: number
  oversubscriptionRatio: number | null  // vps only
  burstable: boolean                    // vps only (t3-style credits, engine models in Phase 2)
}

// Pricing is indicative-realistic (2026 commodity market), not provider-quoted; the cloud
// presets approximate their namesakes so the cost model (Phase 2) lands in the right decade.
export const INSTANCE_CATALOG: InstancePreset[] = [
  { id: 'vps-small',    label: 'VPS Small (2 vCPU / 4 GB)',    kind: 'vps', specs: { vcpu: 2,  threadsPerCore: 1, ramMb: 4096,   diskGb: 40,  nicMbps: 500 },   hourlyUsd: 0.018, oversubscriptionRatio: 6, burstable: true },
  { id: 'vps-medium',   label: 'VPS Medium (4 vCPU / 8 GB)',   kind: 'vps', specs: { vcpu: 4,  threadsPerCore: 1, ramMb: 8192,   diskGb: 80,  nicMbps: 1000 },  hourlyUsd: 0.036, oversubscriptionRatio: 4, burstable: true },
  { id: 'vps-large',    label: 'VPS Large (8 vCPU / 16 GB)',   kind: 'vps', specs: { vcpu: 8,  threadsPerCore: 1, ramMb: 16384,  diskGb: 160, nicMbps: 2000 },  hourlyUsd: 0.071, oversubscriptionRatio: 3, burstable: false },
  { id: 'aws-t3-medium',  label: 'AWS t3.medium (2 vCPU / 4 GB)',   kind: 'vps', specs: { vcpu: 2, threadsPerCore: 2, ramMb: 4096,  diskGb: 60,  nicMbps: 1000 }, hourlyUsd: 0.0416, oversubscriptionRatio: 4, burstable: true },
  { id: 'aws-m7i-large', label: 'AWS m7i.large (2 vCPU / 8 GB)',   kind: 'vps', specs: { vcpu: 2, threadsPerCore: 2, ramMb: 8192,  diskGb: 100, nicMbps: 2500 }, hourlyUsd: 0.1008, oversubscriptionRatio: 2, burstable: false },
  { id: 'gcp-e2-standard-4', label: 'GCP e2-standard-4 (4 vCPU / 16 GB)', kind: 'vps', specs: { vcpu: 4, threadsPerCore: 2, ramMb: 16384, diskGb: 100, nicMbps: 2000 }, hourlyUsd: 0.134, oversubscriptionRatio: 3, burstable: false },
  { id: 'dedicated-8',  label: 'Dedicated 8-core / 32 GB',  kind: 'dedicated', specs: { vcpu: 8,  threadsPerCore: 2, ramMb: 32768,  diskGb: 500,  nicMbps: 10000 }, hourlyUsd: 0.34, oversubscriptionRatio: null, burstable: false },
  { id: 'dedicated-16', label: 'Dedicated 16-core / 64 GB', kind: 'dedicated', specs: { vcpu: 16, threadsPerCore: 2, ramMb: 65536,  diskGb: 1000, nicMbps: 10000 }, hourlyUsd: 0.67, oversubscriptionRatio: null, burstable: false },
  { id: 'dedicated-32', label: 'Dedicated 32-core / 128 GB', kind: 'dedicated', specs: { vcpu: 32, threadsPerCore: 2, ramMb: 131072, diskGb: 2000, nicMbps: 25000 }, hourlyUsd: 1.32, oversubscriptionRatio: null, burstable: false },
]

export function getPreset(id: string): InstancePreset | undefined {
  return INSTANCE_CATALOG.find(p => p.id === id)
}
