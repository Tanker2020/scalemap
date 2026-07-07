import type { NodeType, NodeSimConfig, NodeSlo } from '../../lib/nodeConfig'

export const NODE_SIM_DEFAULTS: Record<NodeType, NodeSimConfig> = {
  // Compute — fixed capacity, no auto-scale, no self-healing
  // maxThreads gives comfortable headroom over PARTICLE_REQUEST_RATIO (10 real requests per
  // visual particle) so a handful of concurrent particles doesn't instantly saturate the pool.
  ec2:          { maxRps: 1000,  processingMs: 10,  errorRate: 0, latencyModel: { p50Ms: 20,  p99Ms: 250  }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 30_000, retryConfig: { maxRetries: 3, baseDelayMs: 100,  jitter: 'full',  maxDelayMs: 2000 }, maxThreads: 100 },
  lambda:       { maxRps: 1000,  processingMs: 50,  errorRate: 0, maxConcurrency: 10, latencyModel: { p50Ms: 80,  p99Ms: 800  }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 29_000, coldStart: { p50Ms: 400, p99Ms: 2500 }, maxWarmInstances: 5, retryConfig: { maxRetries: 2, baseDelayMs: 200,  jitter: 'full',  maxDelayMs: 3000 } },
  container:    { maxRps: 500,   processingMs: 15,  errorRate: 0, latencyModel: { p50Ms: 20,  p99Ms: 250  }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 30_000, retryConfig: { maxRetries: 3, baseDelayMs: 100,  jitter: 'full',  maxDelayMs: 2000 }, maxThreads: 50 },
  // pod deliberately excluded from the thread-pool model: its utilization/scale-out-in triggers
  // are already driven by the HPA/namespace/cluster-quota effectiveMaxRps tiers computed in
  // updateAllNodeMetrics (see the k8sPod branch there) — overriding utilization with a fixed
  // thread pool would silently disable HPA autoscaling. Same reasoning as excluding
  // lambda (its own maxConcurrency+cold-start model). See docs/module-boundaries.md.
  pod:          { maxRps: 300,   processingMs: 20,  errorRate: 0, latencyModel: { p50Ms: 20,  p99Ms: 250  }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 30_000, retryConfig: { maxRetries: 3, baseDelayMs: 100,  jitter: 'full',  maxDelayMs: 2000 }, k8sPod: { replicas: 3, baseCapacityRps: 300, hpa: { minReplicas: 1, maxReplicas: 10, targetCpuUtilization: 0.7 } } },
  // Network
  loadBalancer: { maxRps: 10000, processingMs: 2,   errorRate: 0, latencyModel: { p50Ms: 3,   p99Ms: 20   }, timeoutMs: 60_000, retryConfig: { maxRetries: 2, baseDelayMs: 50,   jitter: 'full',  maxDelayMs: 1000 }, lbRouting: 'round-robin' },
  apiGateway:   { maxRps: 5000,  processingMs: 5,   errorRate: 0, latencyModel: { p50Ms: 10,  p99Ms: 100  }, timeoutMs: 30_000, retryConfig: { maxRetries: 2, baseDelayMs: 100,  jitter: 'equal', maxDelayMs: 2000 }, lbRouting: 'round-robin' },
  cdn:          { maxRps: 20000, processingMs: 1,   errorRate: 0, latencyModel: { p50Ms: 5,   p99Ms: 50   } },
  dns:          { maxRps: 50000, processingMs: 1,   errorRate: 0, latencyModel: { p50Ms: 1,   p99Ms: 10   } },
  firewall:     { maxRps: 5000,  processingMs: 2,   errorRate: 0, latencyModel: { p50Ms: 2,   p99Ms: 15   } },
  vpn:          { maxRps: 1000,  processingMs: 5,   errorRate: 0, latencyModel: { p50Ms: 10,  p99Ms: 80   } },
  // Storage — connection pool limits
  dbSql:        { maxRps: 500,   processingMs: 5,   errorRate: 0, latencyModel: { p50Ms: 8,   p99Ms: 200  }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 10_000, connectionPool: { max: 100,    timeoutMs: 5_000 }, retryConfig: { maxRetries: 2, baseDelayMs: 50,   jitter: 'equal', maxDelayMs: 500  }, dbConfig: { maxReadRps: 5000,  maxWriteRps: 500,  readLatencyMs: 2,  writeLatencyMs: 15 } },
  dbNoSql:      { maxRps: 5000,  processingMs: 2,   errorRate: 0, latencyModel: { p50Ms: 2,   p99Ms: 30   }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 5_000,  connectionPool: { max: 500,    timeoutMs: 2_000 }, retryConfig: { maxRetries: 3, baseDelayMs: 20,   jitter: 'full',  maxDelayMs: 200  }, dbConfig: { maxReadRps: 20000, maxWriteRps: 5000, readLatencyMs: 1,  writeLatencyMs: 5  } },
  objectStorage:{ maxRps: 2000,  processingMs: 50,  errorRate: 0, latencyModel: { p50Ms: 30,  p99Ms: 300  }, connectionPool: { max: 1_000,  timeoutMs: 10_000 } },
  fileStorage:  { maxRps: 500,   processingMs: 20,  errorRate: 0, latencyModel: { p50Ms: 20,  p99Ms: 200  } },
  // Messaging — no retries; queues have their own requeue semantics
  queue:        { maxRps: 10000, processingMs: 0,   errorRate: 0, queueCapacity: 1000, latencyModel: { p50Ms: 1, p99Ms: 10 } },
  eventBus:     { maxRps: 10000, processingMs: 0,   errorRate: 0, queueCapacity: 1000, latencyModel: { p50Ms: 1, p99Ms: 10 } },
  pubsub:       { maxRps: 10000, processingMs: 0,   errorRate: 0, queueCapacity: 1000, latencyModel: { p50Ms: 1, p99Ms: 10 } },
  stream:       { maxRps: 50000, processingMs: 0,   errorRate: 0, queueCapacity: 10000, latencyModel: { p50Ms: 2, p99Ms: 20 } },
  // Caching — high connection limits, short retries (fail fast, fall back to source)
  redis:        { maxRps: 50000, processingMs: 1,   errorRate: 0, latencyModel: { p50Ms: 0.5, p99Ms: 5   }, connectionPool: { max: 10_000, timeoutMs: 200 }, retryConfig: { maxRetries: 1, baseDelayMs: 10,   jitter: 'full',  maxDelayMs: 50   } },
  memcached:    { maxRps: 50000, processingMs: 1,   errorRate: 0, latencyModel: { p50Ms: 0.5, p99Ms: 5   }, connectionPool: { max: 10_000, timeoutMs: 200 }, retryConfig: { maxRetries: 1, baseDelayMs: 10,   jitter: 'full',  maxDelayMs: 50   } },
  cdnCache:     { maxRps: 20000, processingMs: 1,   errorRate: 0, latencyModel: { p50Ms: 3,   p99Ms: 30  } },
  // Orchestration — clusters are grouping containers; capacity is enforced per-pod via k8sCluster config
  k8sCluster:   { maxRps: 999999, processingMs: 0, errorRate: 0, k8sCluster: { nodePoolCapacityRps: 5000, hasServiceMesh: false, cniLatencyMs: 0.5 } },
  ecsCluster:   { maxRps: 999999, processingMs: 0, errorRate: 0, k8sCluster: { nodePoolCapacityRps: 5000, hasServiceMesh: false, cniLatencyMs: 0.5 } },
  dockerCompose:{ maxRps: 999999, processingMs: 0, errorRate: 0, k8sCluster: { nodePoolCapacityRps: 2000, hasServiceMesh: false, cniLatencyMs: 0 } },
  // Grouping — passthrough, not used in capacity checks
  vpc:          { maxRps: 999999, processingMs: 0,  errorRate: 0 },
  subnet:       { maxRps: 999999, processingMs: 0,  errorRate: 0 },
  az:           { maxRps: 999999, processingMs: 0,  errorRate: 0 },
  region:       { maxRps: 999999, processingMs: 0,  errorRate: 0 },
  namespace:    { maxRps: 999999, processingMs: 0,  errorRate: 0, k8sNamespace: { resourceQuotaRps: 10000, networkPolicy: 'open' } },
}

// Default SLOs per node type category (P90-based, production-realistic)
export const DEFAULT_SLO: Partial<Record<NodeType, NodeSlo>> = {
  ec2:          { maxP90LatencyMs: 300,  maxErrorRate: 0.001, maxUtilization: 0.75 },
  lambda:       { maxP90LatencyMs: 1000, maxErrorRate: 0.001, maxUtilization: 0.70 },
  container:    { maxP90LatencyMs: 300,  maxErrorRate: 0.001, maxUtilization: 0.75 },
  pod:          { maxP90LatencyMs: 300,  maxErrorRate: 0.001, maxUtilization: 0.75 },
  apiGateway:   { maxP90LatencyMs: 150,  maxErrorRate: 0.001, maxUtilization: 0.80 },
  loadBalancer: { maxP90LatencyMs: 50,   maxErrorRate: 0.0005, maxUtilization: 0.85 },
  dbSql:        { maxP90LatencyMs: 100,  maxErrorRate: 0.0001, maxUtilization: 0.65 },
  dbNoSql:      { maxP90LatencyMs: 30,   maxErrorRate: 0.0001, maxUtilization: 0.75 },
  redis:        { maxP90LatencyMs: 5,    maxErrorRate: 0.00001, maxUtilization: 0.80 },
  memcached:    { maxP90LatencyMs: 5,    maxErrorRate: 0.00001, maxUtilization: 0.80 },
  queue:        { maxUtilization: 0.80 },
  eventBus:     { maxUtilization: 0.80 },
  pubsub:       { maxUtilization: 0.80 },
  stream:       { maxUtilization: 0.80 },
}
