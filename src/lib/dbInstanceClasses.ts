// src/lib/dbInstanceClasses.ts
// Instance-class catalog for CLOUD-MANAGED databases (node-model Phase 3).
//
// A self-hosted DB (a db-* Server) gets its write ceiling for free from the host CPU model. A
// cloud-managed DB (a ManagedService) has no host, so `flows.ts`'s managed terminal has no
// capacity model at all — it always admits. This catalog gives it one: the chosen class fixes both
// the write/read ceiling AND the hourly price, exactly as picking an RDS/Cloud SQL instance size
// does. One number, two consequences — a bigger box costs more and lifts the write bottleneck.
//
// Provider-agnostic on purpose: modelling AWS db.r6g.* / GCP db-custom / Azure vCore naming three
// times over adds duplication without teaching anything the ladder doesn't. Prices are
// indicative-realistic (2026), meant to land cost in the right decade, like INSTANCE_CATALOG.
import type { DbEngine } from './world/types'

export interface DbInstanceClass {
  id: string
  label: string
  engine: DbEngine
  vcpu: number
  ramMb: number
  writeRps: number   // sustained write ceiling — the SQL single-writer bottleneck / NoSQL per-node
  readRps: number    // read ceiling (always ≥ writeRps; reads are cheaper than writes)
  hourlyUsd: number  // base instance price; ×(1 + replicaCount) for the read replicas
}

// SQL classes: writes bottleneck on the single primary, so writeRps is the headline constraint.
// NoSQL classes: writeRps is PER-NODE — the engine multiplies by node count, so these look
// similar per-box but scale out. Ladders are strictly increasing in price ⇒ writeRps.
export const DB_INSTANCE_CLASSES: DbInstanceClass[] = [
  { id: 'sql.small',   label: 'SQL Small (2 vCPU / 8 GB)',    engine: 'sql',   vcpu: 2,  ramMb: 8192,   writeRps: 500,   readRps: 2500,   hourlyUsd: 0.10 },
  { id: 'sql.medium',  label: 'SQL Medium (4 vCPU / 16 GB)',  engine: 'sql',   vcpu: 4,  ramMb: 16384,  writeRps: 1200,  readRps: 6000,   hourlyUsd: 0.24 },
  { id: 'sql.large',   label: 'SQL Large (8 vCPU / 32 GB)',   engine: 'sql',   vcpu: 8,  ramMb: 32768,  writeRps: 2800,  readRps: 14000,  hourlyUsd: 0.48 },
  { id: 'sql.xlarge',  label: 'SQL XLarge (16 vCPU / 64 GB)', engine: 'sql',   vcpu: 16, ramMb: 65536,  writeRps: 6000,  readRps: 30000,  hourlyUsd: 0.96 },
  { id: 'nosql.small', label: 'NoSQL Small (2 vCPU / 8 GB)',  engine: 'nosql', vcpu: 2,  ramMb: 8192,   writeRps: 1000,  readRps: 4000,   hourlyUsd: 0.09 },
  { id: 'nosql.medium',label: 'NoSQL Medium (4 vCPU / 16 GB)',engine: 'nosql', vcpu: 4,  ramMb: 16384,  writeRps: 2500,  readRps: 10000,  hourlyUsd: 0.20 },
  { id: 'nosql.large', label: 'NoSQL Large (8 vCPU / 32 GB)', engine: 'nosql', vcpu: 8,  ramMb: 32768,  writeRps: 6000,  readRps: 24000,  hourlyUsd: 0.40 },
]

export function getDbInstanceClass(id: string | null | undefined): DbInstanceClass | undefined {
  if (!id) return undefined
  return DB_INSTANCE_CLASSES.find(c => c.id === id)
}

// The class a freshly-created cloud DB of this engine starts on (the smallest — cheapest, so a new
// DB never surprises the cost readout, and the user sizes up as load demands).
export function defaultDbClassId(engine: DbEngine): string {
  return DB_INSTANCE_CLASSES.find(c => c.engine === engine)!.id
}
