import {
  Server, Zap, Box, Circle,
  GitBranch, Globe, Wifi, Link2, Shield, Lock,
  Database, Archive, HardDrive,
  AlignLeft, Radio, Share2, Activity,
  Layers,
  Cpu, Package,
  Layout, Map,
  type LucideIcon,
} from 'lucide-react'
import { CATEGORY_COLORS } from './theme'

export type NodeStatus = 'healthy' | 'degraded' | 'down' | 'idle'

export type NodeCategory = keyof typeof CATEGORY_COLORS

export type NodeType =
  | 'ec2' | 'lambda' | 'container' | 'pod'
  | 'loadBalancer' | 'apiGateway' | 'cdn' | 'dns' | 'firewall' | 'vpn'
  | 'dbSql' | 'dbNoSql' | 'objectStorage' | 'fileStorage'
  | 'queue' | 'eventBus' | 'pubsub' | 'stream'
  | 'redis' | 'memcached' | 'cdnCache'
  | 'k8sCluster' | 'ecsCluster' | 'dockerCompose'
  | 'vpc' | 'subnet' | 'az' | 'region' | 'namespace'

export type EdgeType = 'request' | 'stream' | 'event' | 'dependency'

export interface LatencyModel {
  p50Ms: number
  p99Ms: number
}

export interface TrafficOrigin {
  regionId: string      // must match a WorldRegion.id from regionConfig.ts
  weight: number        // 0.0–1.0; weights should sum to ~1.0
  baseLatencyMs: number // auto-filled from WORLD_REGIONS.baseLatencyMs, user-overridable
}

export interface RetryConfig {
  maxRetries: number          // 0 disables retries entirely
  baseDelayMs: number         // delay before the first retry attempt
  jitter: 'full' | 'equal'   // full: random(0, cap); equal: cap/2 + random(0, cap/2)
  maxDelayMs?: number         // cap on exponential growth
}

export interface NodeSlo {
  maxP90LatencyMs?: number
  maxErrorRate?: number
  maxUtilization?: number
}

export interface NodeSimConfig {
  maxRps: number
  maxConcurrency?: number
  processingMs: number
  errorRate: number
  queueCapacity?: number
  latencyModel?: LatencyModel
  circuitBreaker?: {
    errorThreshold: number
    resetMs: number
  }
  connectionPool?: {
    max: number
    timeoutMs: number
  }
  timeoutMs?: number
  retryConfig?: RetryConfig
  lbRouting?: 'round-robin' | 'least-connections'
  forcedHealthState?: 'auto' | 'healthy' | 'degraded' | 'down'
  trafficOrigins?: TrafficOrigin[]  // CDN, loadBalancer, apiGateway only
  coldStart?: {
    p50Ms: number
    p99Ms: number
  }
  maxWarmInstances?: number
  autoScale?: {
    minCapacityRps: number
    maxCapacityRps: number
    scaleOutThreshold: number
    scaleOutDelayMs: number
    scaleInThreshold: number
    scaleInCooldownMs: number
  }
  selfHealing?: {
    restartDelayMs: number
    maxRestarts: number
    crashLoopBackoffMs: number
  }
}

export interface NodeData extends Record<string, unknown> {
  label: string
  subtitle: string
  status: NodeStatus
  notes: string
  warnings: string[]
  simConfig?: Partial<NodeSimConfig>
  slo?: NodeSlo
  regionId?: string  // set on 'region' grouping nodes; links to WorldRegion.id
}

export interface EdgeData extends Record<string, unknown> {
  label: string
  edgeType: EdgeType
  throughput: number
  latency: number
}

export interface NodeConfig {
  label: string
  icon: LucideIcon
  category: NodeCategory
  isGroup?: boolean
}

export const NODE_CONFIG: Record<NodeType, NodeConfig> = {
  // Compute
  ec2:          { label: 'EC2 / VM',          icon: Server,    category: 'compute' },
  lambda:       { label: 'Lambda',             icon: Zap,       category: 'compute' },
  container:    { label: 'Container',          icon: Box,       category: 'compute' },
  pod:          { label: 'Pod',                icon: Circle,    category: 'compute' },
  // Network
  loadBalancer: { label: 'Load Balancer',      icon: GitBranch, category: 'network' },
  apiGateway:   { label: 'API Gateway',        icon: Globe,     category: 'network' },
  cdn:          { label: 'CDN',                icon: Wifi,      category: 'network' },
  dns:          { label: 'DNS',                icon: Link2,     category: 'network' },
  firewall:     { label: 'Firewall',           icon: Shield,    category: 'network' },
  vpn:          { label: 'VPN',                icon: Lock,      category: 'network' },
  // Storage
  dbSql:        { label: 'Database (SQL)',      icon: Database,  category: 'storage' },
  dbNoSql:      { label: 'Database (NoSQL)',    icon: Database,  category: 'storage' },
  objectStorage:{ label: 'Object Storage',     icon: Archive,   category: 'storage' },
  fileStorage:  { label: 'File Storage',       icon: HardDrive, category: 'storage' },
  // Messaging
  queue:        { label: 'Message Queue',      icon: AlignLeft, category: 'messaging' },
  eventBus:     { label: 'Event Bus',          icon: Radio,     category: 'messaging' },
  pubsub:       { label: 'Pub/Sub Topic',      icon: Share2,    category: 'messaging' },
  stream:       { label: 'Stream (Kafka)',      icon: Activity,  category: 'messaging' },
  // Caching
  redis:        { label: 'Redis',              icon: Layers,    category: 'caching' },
  memcached:    { label: 'Memcached',          icon: Layers,    category: 'caching' },
  cdnCache:     { label: 'CDN Cache',          icon: Wifi,      category: 'caching' },
  // Orchestration
  k8sCluster:   { label: 'K8s Cluster',        icon: Cpu,       category: 'orchestration' },
  ecsCluster:   { label: 'ECS Cluster',        icon: Cpu,       category: 'orchestration' },
  dockerCompose:{ label: 'Docker Compose',     icon: Package,   category: 'orchestration' },
  // Grouping
  vpc:          { label: 'VPC',                icon: Layout,    category: 'grouping', isGroup: true },
  subnet:       { label: 'Subnet',             icon: Layout,    category: 'grouping', isGroup: true },
  az:           { label: 'Availability Zone',  icon: Layout,    category: 'grouping', isGroup: true },
  region:       { label: 'Region',             icon: Map,       category: 'grouping', isGroup: true },
  namespace:    { label: 'Namespace',          icon: Layout,    category: 'grouping', isGroup: true },
}

export const GROUPING_TYPES = new Set<NodeType>(['vpc', 'subnet', 'az', 'region', 'namespace'])

export const PALETTE_CATEGORIES: { label: string; category: NodeCategory; types: NodeType[] }[] = [
  { label: 'Compute',       category: 'compute',       types: ['ec2', 'lambda', 'container', 'pod'] },
  { label: 'Network',       category: 'network',       types: ['loadBalancer', 'apiGateway', 'cdn', 'dns', 'firewall', 'vpn'] },
  { label: 'Storage',       category: 'storage',       types: ['dbSql', 'dbNoSql', 'objectStorage', 'fileStorage'] },
  { label: 'Messaging',     category: 'messaging',     types: ['queue', 'eventBus', 'pubsub', 'stream'] },
  { label: 'Caching',       category: 'caching',       types: ['redis', 'memcached', 'cdnCache'] },
  { label: 'Orchestration', category: 'orchestration', types: ['k8sCluster', 'ecsCluster', 'dockerCompose'] },
  { label: 'Grouping',      category: 'grouping',      types: ['vpc', 'subnet', 'az', 'region', 'namespace'] },
]
