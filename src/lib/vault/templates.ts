import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodeConfig'

export interface VaultTemplate {
  id: string
  name: string
  description: string
  category: 'web' | 'data' | 'serverless' | 'k8s' | 'network'
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

function n(id: string, type: string, x: number, y: number, label: string, subtitle = '', parentId?: string, style?: Record<string, unknown>): Node<NodeData> {
  return { id, type, position: { x, y }, data: { label, subtitle, status: 'healthy', notes: '', warnings: [] }, ...(parentId ? { parentId } : {}), ...(style ? { style } : {}) } as Node<NodeData>
}

function e(id: string, source: string, target: string, edgeType = 'request', throughput = 200, latency = 20): Edge<EdgeData> {
  return { id, source, target, type: edgeType, data: { label: '', edgeType: edgeType as EdgeData['edgeType'], throughput, latency } } as Edge<EdgeData>
}

export const VAULT_TEMPLATES: VaultTemplate[] = [
  {
    id: 'basic-vpc-ec2',
    name: 'Basic VPC + EC2',
    description: 'Single-region VPC with public subnet, EC2 instance, and Route 53',
    category: 'network',
    nodes: [
      n('v-vpc',    'vpc',    60,  60,  'main-vpc',      '10.0.0.0/16', undefined, { width: 500, height: 320 }),
      n('v-sub',    'subnet', 60,  80,  'public-subnet', '10.0.1.0/24', 'v-vpc',   { width: 360, height: 180 }),
      n('v-ec2',    'ec2',    90,  60,  'app-server',    't3.medium',   'v-sub'),
      n('v-dns',    'dns',    620, 200, 'Route 53',      'DNS routing'),
    ],
    edges: [
      e('ve-1', 'v-dns', 'v-ec2'),
    ],
  },
  {
    id: 'load-balanced-cluster',
    name: 'Load Balanced Cluster',
    description: 'ALB distributing traffic across EC2 instances with RDS backend',
    category: 'web',
    nodes: [
      n('lb-cdn',  'cdn',          80,  200, 'CloudFront',     'CDN layer'),
      n('lb-alb',  'loadBalancer', 300, 200, 'App Load Balancer', 'ALB'),
      n('lb-ec1',  'ec2',          540, 120, 'app-server-1',   't3.medium'),
      n('lb-ec2',  'ec2',          540, 300, 'app-server-2',   't3.medium'),
      n('lb-db',   'dbSql',        760, 200, 'RDS Postgres',   'db.t3.large'),
    ],
    edges: [
      e('lbe-1', 'lb-cdn',  'lb-alb'),
      e('lbe-2', 'lb-alb',  'lb-ec1'),
      e('lbe-3', 'lb-alb',  'lb-ec2'),
      e('lbe-4', 'lb-ec1',  'lb-db'),
      e('lbe-5', 'lb-ec2',  'lb-db'),
    ],
  },
  {
    id: 'serverless-stack',
    name: 'Serverless Stack',
    description: 'API Gateway fronting Lambda functions with DynamoDB and S3',
    category: 'serverless',
    nodes: [
      n('sl-gw',  'apiGateway',    80,  200, 'API Gateway',  'REST API'),
      n('sl-fna', 'lambda',        320, 120, 'users-fn',     'Node 20'),
      n('sl-fnb', 'lambda',        320, 300, 'orders-fn',    'Node 20'),
      n('sl-dyn', 'dbNoSql',       560, 200, 'DynamoDB',     'on-demand'),
      n('sl-s3',  'objectStorage', 560, 360, 'S3 Bucket',    'assets'),
    ],
    edges: [
      e('sle-1', 'sl-gw',  'sl-fna'),
      e('sle-2', 'sl-gw',  'sl-fnb'),
      e('sle-3', 'sl-fna', 'sl-dyn'),
      e('sle-4', 'sl-fnb', 'sl-dyn'),
      e('sle-5', 'sl-fnb', 'sl-s3'),
    ],
  },
  {
    id: 'event-driven',
    name: 'Event-Driven Pipeline',
    description: 'EventBridge routing to SQS queues consumed by Lambda workers',
    category: 'serverless',
    nodes: [
      n('ev-src', 'ec2',      80,  220, 'Producer',       'event source'),
      n('ev-bus', 'eventBus', 280, 220, 'EventBridge',    'event router'),
      n('ev-q',   'queue',    480, 140, 'Main Queue',     'SQS FIFO'),
      n('ev-dlq', 'queue',    480, 320, 'Dead Letter Q',  'SQS DLQ'),
      n('ev-w1',  'lambda',   700, 100, 'worker-fn-1',    'Python 3.12'),
      n('ev-w2',  'lambda',   700, 220, 'worker-fn-2',    'Python 3.12'),
      n('ev-db',  'dbNoSql',  920, 160, 'Results DB',     'DynamoDB'),
    ],
    edges: [
      e('eve-1', 'ev-src', 'ev-bus', 'event'),
      e('eve-2', 'ev-bus', 'ev-q',   'event'),
      e('eve-3', 'ev-bus', 'ev-dlq', 'event'),
      e('eve-4', 'ev-q',   'ev-w1'),
      e('eve-5', 'ev-q',   'ev-w2'),
      e('eve-6', 'ev-w1',  'ev-db'),
      e('eve-7', 'ev-w2',  'ev-db'),
    ],
  },
  {
    id: 'k8s-microservices',
    name: 'Kubernetes Microservices',
    description: 'EKS cluster with service pods, Redis cache, and RDS Postgres',
    category: 'k8s',
    nodes: [
      n('k8-lb',  'loadBalancer', 60,  260, 'Ingress / ALB', 'k8s ingress'),
      n('k8-cl',  'k8sCluster',   300, 80,  'EKS Cluster',  'us-east-1', undefined, { width: 480, height: 340 }),
      n('k8-ns',  'namespace',    40,  70,  'app',          'namespace', 'k8-cl',   { width: 380, height: 230 }),
      n('k8-pa',  'pod',          40,  70,  'api-pod',      'x3 replicas', 'k8-ns'),
      n('k8-pb',  'pod',          210, 70,  'worker-pod',   'x2 replicas', 'k8-ns'),
      n('k8-pc',  'pod',          40,  150, 'auth-pod',     'x2 replicas', 'k8-ns'),
      n('k8-rd',  'redis',        840, 160, 'ElastiCache',  'cache.t3.micro'),
      n('k8-db',  'dbSql',        840, 320, 'RDS Postgres', 'db.t3.large'),
    ],
    edges: [
      e('k8e-1', 'k8-lb',  'k8-pa'),
      e('k8e-2', 'k8-pa',  'k8-db'),
      e('k8e-3', 'k8-pa',  'k8-rd'),
      e('k8e-4', 'k8-pa',  'k8-pb'),
      e('k8e-5', 'k8-pb',  'k8-db'),
    ],
  },
  {
    id: 'data-pipeline',
    name: 'Data Pipeline',
    description: 'Kinesis streaming ingestion, Lambda processing, S3 data lake + Redshift',
    category: 'data',
    nodes: [
      n('dp-src', 'ec2',           80,  200, 'Data Sources',  'producers'),
      n('dp-str', 'stream',        300, 200, 'Kinesis Stream', '4 shards'),
      n('dp-fn',  'lambda',        520, 200, 'transform-fn',  'stream proc'),
      n('dp-s3',  'objectStorage', 740, 120, 'S3 Data Lake',  'raw + processed'),
      n('dp-rs',  'dbSql',         740, 300, 'Redshift',      'data warehouse'),
      n('dp-rd',  'redis',         960, 200, 'Redis Cache',   'query results'),
    ],
    edges: [
      e('dpe-1', 'dp-src', 'dp-str', 'stream', 5000, 10),
      e('dpe-2', 'dp-str', 'dp-fn',  'stream', 5000, 10),
      e('dpe-3', 'dp-fn',  'dp-s3'),
      e('dpe-4', 'dp-fn',  'dp-rs'),
      e('dpe-5', 'dp-rs',  'dp-rd'),
    ],
  },
]
