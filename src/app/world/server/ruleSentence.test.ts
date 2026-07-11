import { describe, it, expect } from 'vitest'
import { ruleSentence } from './ruleSentence'

describe('ruleSentence', () => {
  it('allow 443 tcp any → "Let anyone reach https :443"', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 443, protocol: 'tcp', source: 'any' }))
      .toBe('Let anyone reach https :443')
  })
  it('deny 6379 tcp internal → "Block internal traffic reaching redis :6379"', () => {
    expect(ruleSentence({ id: 'r', action: 'deny', port: 6379, protocol: 'tcp', source: 'internal' }))
      .toBe('Block internal traffic reaching redis :6379')
  })
  it('factory default allow any any internal reads clean (no protocol noise)', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 'any', protocol: 'any', source: 'internal' }))
      .toBe('Let internal traffic reach any port')
  })
  it('udp is the only spelled protocol; unknown ports stay bare; CIDRs verbatim', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 9200, protocol: 'udp', source: '10.0.0.0/8' }))
      .toBe('Let 10.0.0.0/8 reach :9200 udp')
    expect(ruleSentence({ id: 'r', action: 'deny', port: 22, protocol: 'tcp', source: 'any' }))
      .toBe('Block anyone reaching ssh :22')
  })
})
