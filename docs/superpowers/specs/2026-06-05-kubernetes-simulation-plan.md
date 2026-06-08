# Kubernetes Simulation Architecture Plan

This document outlines the comprehensive plan for remodeling Kubernetes mechanics within the Scalemap simulation engine. The goal is to move from visual approximations to "Engineering-Grade Realism," accurately simulating distributed systems constraints like Thread Starvation, Consumer Lag, and Resource Contention.

## Phase 1: Visual Hierarchy & Node Redefinition

The core conceptual shift is elevating the `pod` to the atomic unit of compute, and treating clusters and namespaces as bounding constraints.

### 1. Deprecate Containers
*   **Action:** Remove the `container` node type from `src/lib/nodeConfig.ts` (`NodeType` union and `NODE_CONFIG`).
*   **Rationale:** Containers share network namespaces within a pod; traffic routing targets the pod. Granular container modeling adds UI clutter without simulation value.

### 2. Promote Clusters to Grouping Nodes
*   **Action:** Move `k8sCluster` and `ecsCluster` into the `GROUPING_TYPES` array.
*   **Rationale:** Clusters are boundaries that contain infrastructure, not direct compute targets. Users will drag cluster boxes onto the canvas and place pods inside them.
*   **Hierarchy:** `k8sCluster` (Group) -> `namespace` (Group) -> `pod` (Node).

### 3. Redefine Pods as Workloads (Deployments)
*   **Action:** The `pod` node now semantically represents a Fleet (Deployment/ReplicaSet).
*   **Rationale:** Architectural diagrams represent services, not individual replicas.

## Phase 2: Configuration Schema Upgrades

We must expand `NodeSimConfig` to support Kubernetes-specific resource constraints.

### 1. Pod Configuration (`K8sConfig`)
Add properties to `pod` configurations to define horizontal scaling rules.
```typescript
// Proposed additions to NodeSimConfig
export interface NodeSimConfig {
  // ... existing configs
  k8sPod?: {
    replicas: number;           // Current static count
    baseCapacityRps: number;    // Capacity of a SINGLE replica
    hpa?: {
      minReplicas: number;
      maxReplicas: number;
      targetCpuUtilization: number;
    };
  };
}
```

### 2. Namespace Configuration (Resource Quotas)
Add configuration to `namespace` grouping nodes to define hard resource ceilings.
```typescript
export interface NodeSimConfig {
  // ... existing configs
  k8sNamespace?: {
    resourceQuotaRps: number;   // Max combined RPS for all pods in this namespace
    networkPolicy: 'open' | 'strict'; // Strict prevents inbound traffic from outside the namespace
  };
}
```

### 3. Cluster Configuration (Node Pools & Service Mesh)
Add configuration to `k8sCluster` grouping nodes to define hardware limits and global latency taxes.
```typescript
export interface NodeSimConfig {
  // ... existing configs
  k8sCluster?: {
    nodePoolCapacityRps: number; // Max combined RPS for ALL pods in the cluster
    hasServiceMesh: boolean;     // e.g., Istio/Linkerd
    cniLatencyMs: number;        // Baseline network overhead
  };
}
```

## Phase 3: Engine Mechanics (The rAF Loop)

The true value lies in modifying `updateAllNodeMetrics` and `handleParticleArrival` in `particleEngine.ts` to enforce these constraints mathematically.

### 1. Effective Capacity Calculation (The "Whichever is Lower" Rule)
When calculating a pod's `effectiveMaxRps`, the engine must evaluate three tiers of constraints:

1.  **Pod Level:** `pod.k8sPod.replicas * pod.k8sPod.baseCapacityRps`
2.  **Namespace Level:** `namespace.resourceQuotaRps - sum(otherPodsInNamespace)`
3.  **Cluster Level:** `cluster.nodePoolCapacityRps - sum(allOtherPodsInCluster)`

The pod's final `effectiveMaxRps` is the **lowest** value among these three.

### 2. Simulating Resource Contention (Noisy Neighbors)
If a pod's capacity is artificially clamped by the Namespace or Cluster limits (meaning Tier 2 or 3 is the lowest value), and the pod subsequently hits 1.0 utilization:
*   The pod saturates and begins dropping traffic locally (turning red).
*   The engine emits a specific event to the Event Log: `quota_constrained` or `cluster_exhausted`. This clearly informs the user *why* the failure occurred (the boundary failed, not the microservice).

### 3. HPA Gridlock (Pending Pods)
When evaluating the Horizontal Pod Autoscaler (HPA) logic:
*   If a pod's utilization exceeds `targetCpuUtilization`, it attempts to increment `replicas`.
*   The engine must first check if the `capacityIncrease` fits within the remaining Namespace and Cluster budgets.
*   If the budget is exhausted, the scale-out is **blocked**. The replicas do not increase, utilization remains high, and an `hpa_blocked` event is emitted to the Event Log.

### 4. The Service Mesh Tax
If the parent `k8sCluster` grouping node has `hasServiceMesh: true`:
*   In `handleParticleArrival`, intercept all particles landing on nodes within this cluster.
*   Apply a fixed penalty (e.g., `+2ms`) to the calculated latency *before* processing. This accurately models the baseline overhead of an Envoy sidecar topology.

### 5. Blast Radius (Dependency Cascades)
Leveraging the grouping hierarchy:
*   If Chaos Mode or a user forces the `k8sCluster` or `namespace` node state to `down`, the engine iterates through all child `pod` nodes.
*   It immediately forces their state to `down`, tripping all inbound circuit breakers instantly. This models a control plane or catastrophic physical node failure.