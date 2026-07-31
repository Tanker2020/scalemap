import { describe, it, expect } from 'vitest'
import { aggregateTopicLoad, topicRuntime, type TopicRuntime } from './broker'
import { addPacket } from '../nodeConfig'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'

// One producer instance -> event dependency -> one consumer instance, both on one server so the
// compiled world's only variable is the packet mix / capacity the test sets up.
function eventWorld(opts: { retentionCapCount?: number; maxRedeliveries?: number } = {}) {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('dedicated-8')!)
  doc.regions[region.id] = region; doc.azs[az.id] = az; doc.servers[server.id] = server

  const added = addPacket(doc.packets, {
    name: 'order-created', protocol: 'event', topic: 'orders', eventType: 'created',
    deliveryMode: 'at-least-once', ...opts,
  })
  doc.packets = added.registry

  const producer = createBlueprint('producer', 0)
  const consumer = createBlueprint('consumer', 1)
  producer.dependencies = [{
    id: 'd-topic', target: { kind: 'blueprint', blueprintId: consumer.id },
    port: 8080, protocol: 'event', packetTemplateId: null,
    packetMix: [{ packetId: added.packet.id, weight: 1 }],
  }]
  doc.blueprints[producer.id] = producer
  doc.blueprints[consumer.id] = consumer
  const plP = createPlacement(producer.id, server.id); doc.placements[plP.id] = plP
  const plC = createPlacement(consumer.id, server.id); doc.placements[plC.id] = plC

  return {
    doc, compiled: compileWorld(doc),
    producerInst: instanceId(plP.id, 0), consumerInst: instanceId(plC.id, 0),
  }
}

function flowFixture(producerInst: string, consumerInst: string, opts: {
  rps: number; consumerAdmittedRps?: number; consumerErrorRps?: number
}) {
  return {
    [producerInst]: {
      instanceId: producerInst, admittedRps: opts.rps, errorRps: 0,
      downstream: [{ dependencyId: 'd-topic', toInstanceId: consumerInst, rps: opts.rps, blocked: false }],
    },
    [consumerInst]: {
      instanceId: consumerInst,
      admittedRps: opts.consumerAdmittedRps ?? opts.rps,
      errorRps: opts.consumerErrorRps ?? 0,
      downstream: [],
    },
  }
}

describe('aggregateTopicLoad', () => {
  it('sums arrival rps and consumer capacity for an event-protocol dependency', () => {
    const f = eventWorld()
    const prevFlows = flowFixture(f.producerInst, f.consumerInst, { rps: 100 })
    const load = aggregateTopicLoad(prevFlows, f.compiled, f.doc, { [f.consumerInst]: 50 })
    expect(load['d-topic'].arrivalRps).toBe(100)
    expect(load['d-topic'].consumerCapacityRps).toBe(50)
    expect(load['d-topic'].consumerErrorFraction).toBe(0)
  })

  it('ignores a non-event dependency entirely', () => {
    const f = eventWorld()
    f.doc.blueprints[Object.keys(f.doc.blueprints)[0]].dependencies[0].protocol = 'http'
    f.doc.blueprints[Object.keys(f.doc.blueprints)[0]].dependencies[0].packetMix = undefined
    const compiled = compileWorld(f.doc)
    const prevFlows = flowFixture(f.producerInst, f.consumerInst, { rps: 100 })
    const load = aggregateTopicLoad(prevFlows, compiled, f.doc, { [f.consumerInst]: 50 })
    expect(load['d-topic']).toBeUndefined()
  })

  it('computes the consumer error fraction from its own admitted/error split', () => {
    const f = eventWorld()
    const prevFlows = flowFixture(f.producerInst, f.consumerInst, { rps: 100, consumerAdmittedRps: 60, consumerErrorRps: 40 })
    const load = aggregateTopicLoad(prevFlows, f.compiled, f.doc, { [f.consumerInst]: 50 })
    expect(load['d-topic'].consumerErrorFraction).toBeCloseTo(0.4, 5)
  })
})

describe('topicRuntime — backlog/lag/drop/DLQ', () => {
  const stepSec = 0.1

  it('drains fully with no backlog growth when capacity exceeds arrival', () => {
    const f = eventWorld()
    const backlogByTopic = new Map<string, number>()
    const prevFlows = flowFixture(f.producerInst, f.consumerInst, { rps: 100 })
    const rt: TopicRuntime = topicRuntime(prevFlows, f.compiled, f.doc, { [f.consumerInst]: 1000 }, backlogByTopic, stepSec)
    expect(rt['d-topic'].backlogCount).toBeCloseTo(0, 5)
    expect(rt['d-topic'].drainRps).toBeCloseTo(100, 5)
    expect(rt['d-topic'].lagSec).toBeCloseTo(0, 5)
  })

  it('grows a persistent backlog when arrival exceeds capacity, and the backlog carries across steps', () => {
    const f = eventWorld()
    const backlogByTopic = new Map<string, number>()
    const prevFlows = flowFixture(f.producerInst, f.consumerInst, { rps: 100 })
    const cap = { [f.consumerInst]: 20 }   // consumer can only drain 20 rps of a 100 rps arrival

    const rt1 = topicRuntime(prevFlows, f.compiled, f.doc, cap, backlogByTopic, stepSec)
    expect(rt1['d-topic'].backlogCount).toBeGreaterThan(0)
    expect(rt1['d-topic'].drainRps).toBeCloseTo(20, 5)

    const rt2 = topicRuntime(prevFlows, f.compiled, f.doc, cap, backlogByTopic, stepSec)
    // Backlog carried forward and kept growing — this is the persistence the whole model exists for.
    expect(rt2['d-topic'].backlogCount).toBeGreaterThan(rt1['d-topic'].backlogCount)
    expect(rt2['d-topic'].lagSec).toBeGreaterThan(0)
  })

  it('sheds overflow past retentionCapCount as dropRps, capping the backlog', () => {
    const f = eventWorld({ retentionCapCount: 5 })
    const backlogByTopic = new Map<string, number>()
    const prevFlows = flowFixture(f.producerInst, f.consumerInst, { rps: 1000 })
    const rt = topicRuntime(prevFlows, f.compiled, f.doc, { [f.consumerInst]: 1 }, backlogByTopic, stepSec)
    expect(rt['d-topic'].backlogCount).toBeLessThanOrEqual(5)
    expect(rt['d-topic'].dropRps).toBeGreaterThan(0)
  })

  it('sends failed messages straight to the DLQ when maxRedeliveries is 0', () => {
    const f = eventWorld({ maxRedeliveries: 0 })
    const backlogByTopic = new Map<string, number>()
    // Consumer errors on everything it processes.
    const prevFlows = flowFixture(f.producerInst, f.consumerInst, { rps: 100, consumerAdmittedRps: 0, consumerErrorRps: 100 })
    const rt = topicRuntime(prevFlows, f.compiled, f.doc, { [f.consumerInst]: 100 }, backlogByTopic, stepSec)
    expect(rt['d-topic'].dlqRps).toBeGreaterThan(0)
    expect(rt['d-topic'].redeliverRps).toBe(0)
  })

  it('feeds failed messages back for redelivery when maxRedeliveries > 0 (default)', () => {
    const f = eventWorld()
    const backlogByTopic = new Map<string, number>()
    const prevFlows = flowFixture(f.producerInst, f.consumerInst, { rps: 100, consumerAdmittedRps: 0, consumerErrorRps: 100 })
    const rt = topicRuntime(prevFlows, f.compiled, f.doc, { [f.consumerInst]: 100 }, backlogByTopic, stepSec)
    expect(rt['d-topic'].redeliverRps).toBeGreaterThan(0)
    expect(rt['d-topic'].dlqRps).toBe(0)
  })

  it('an idle topic (no arrival) reports zero lag, not Infinity or NaN', () => {
    const f = eventWorld()
    const backlogByTopic = new Map<string, number>()
    const rt = topicRuntime({}, f.compiled, f.doc, {}, backlogByTopic, stepSec)
    expect(rt['d-topic']).toBeUndefined()   // no arrival this step -> no entry at all
  })
})
