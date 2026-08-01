export interface WorldRegion {
  id: string
  label: string
  zone: 'AMER' | 'EMEA' | 'APAC'
  baseLatencyMs: number  // approximate latency from a US East reference client
}

export const WORLD_REGIONS: WorldRegion[] = [
  // AMER
  { id: 'us-east-1',      label: 'US East (N. Virginia)',     zone: 'AMER', baseLatencyMs: 15  },
  { id: 'us-east-2',      label: 'US East (Ohio)',            zone: 'AMER', baseLatencyMs: 20  },
  { id: 'us-west-1',      label: 'US West (N. California)',   zone: 'AMER', baseLatencyMs: 68  },
  { id: 'us-west-2',      label: 'US West (Oregon)',          zone: 'AMER', baseLatencyMs: 65  },
  { id: 'ca-central-1',   label: 'Canada (Central)',          zone: 'AMER', baseLatencyMs: 18  },
  { id: 'sa-east-1',      label: 'South America (São Paulo)', zone: 'AMER', baseLatencyMs: 115 },
  // EMEA
  { id: 'eu-west-1',      label: 'Europe (Ireland)',          zone: 'EMEA', baseLatencyMs: 75  },
  { id: 'eu-west-2',      label: 'Europe (London)',           zone: 'EMEA', baseLatencyMs: 80  },
  { id: 'eu-west-3',      label: 'Europe (Paris)',            zone: 'EMEA', baseLatencyMs: 78  },
  { id: 'eu-central-1',   label: 'Europe (Frankfurt)',        zone: 'EMEA', baseLatencyMs: 85  },
  { id: 'eu-south-1',     label: 'Europe (Milan)',            zone: 'EMEA', baseLatencyMs: 88  },
  { id: 'eu-north-1',     label: 'Europe (Stockholm)',        zone: 'EMEA', baseLatencyMs: 92  },
  { id: 'me-south-1',     label: 'Middle East (Bahrain)',     zone: 'EMEA', baseLatencyMs: 120 },
  { id: 'af-south-1',     label: 'Africa (Cape Town)',        zone: 'EMEA', baseLatencyMs: 175 },
  // APAC
  { id: 'ap-south-1',     label: 'Asia Pacific (Mumbai)',     zone: 'APAC', baseLatencyMs: 130 },
  { id: 'ap-southeast-1', label: 'Asia Pacific (Singapore)',  zone: 'APAC', baseLatencyMs: 160 },
  { id: 'ap-southeast-2', label: 'Asia Pacific (Sydney)',     zone: 'APAC', baseLatencyMs: 210 },
  { id: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)',      zone: 'APAC', baseLatencyMs: 175 },
  { id: 'ap-northeast-2', label: 'Asia Pacific (Seoul)',      zone: 'APAC', baseLatencyMs: 180 },
  { id: 'ap-northeast-3', label: 'Asia Pacific (Osaka)',      zone: 'APAC', baseLatencyMs: 178 },
  { id: 'ap-east-1',      label: 'Asia Pacific (Hong Kong)',  zone: 'APAC', baseLatencyMs: 165 },
]

// Zone-to-zone baseline latency in ms (symmetric)
const ZONE_LATENCY_MS: Record<string, Record<string, number>> = {
  AMER: { AMER: 40,  EMEA: 80,  APAC: 170 },
  EMEA: { AMER: 80,  EMEA: 25,  APAC: 140 },
  APAC: { AMER: 170, EMEA: 140, APAC: 35  },
}

export function interRegionLatencyMs(fromId: string, toId: string): number {
  if (fromId === toId) return 0
  const from = WORLD_REGIONS.find(r => r.id === fromId)
  const to   = WORLD_REGIONS.find(r => r.id === toId)
  if (!from || !to) return 0
  if (from.zone === to.zone) {
    // Same zone: use delta of base latencies + small floor
    return Math.abs(from.baseLatencyMs - to.baseLatencyMs) + 10
  }
  return ZONE_LATENCY_MS[from.zone][to.zone]
}


export const REGIONS_BY_ZONE = {
  AMER: WORLD_REGIONS.filter(r => r.zone === 'AMER'),
  EMEA: WORLD_REGIONS.filter(r => r.zone === 'EMEA'),
  APAC: WORLD_REGIONS.filter(r => r.zone === 'APAC'),
}
