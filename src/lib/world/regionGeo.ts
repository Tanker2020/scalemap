// Approximate datacenter-metro coordinates for each WORLD_REGIONS entry (globe pins, Phase 5)
// and client→region distance ordering (routing tables, Task 6).

export const REGION_GEO: Record<string, { lat: number; lon: number }> = {
  'us-east-1':      { lat: 38.9,  lon: -77.5 },   // N. Virginia
  'us-east-2':      { lat: 40.0,  lon: -83.0 },   // Ohio
  'us-west-1':      { lat: 37.4,  lon: -121.9 },  // N. California
  'us-west-2':      { lat: 45.8,  lon: -119.7 },  // Oregon
  'ca-central-1':   { lat: 45.5,  lon: -73.6 },   // Montreal
  'sa-east-1':      { lat: -23.5, lon: -46.6 },   // São Paulo
  'eu-west-1':      { lat: 53.3,  lon: -6.3 },    // Ireland
  'eu-west-2':      { lat: 51.5,  lon: -0.1 },    // London
  'eu-west-3':      { lat: 48.9,  lon: 2.4 },     // Paris
  'eu-central-1':   { lat: 50.1,  lon: 8.7 },     // Frankfurt
  'eu-south-1':     { lat: 45.5,  lon: 9.2 },     // Milan
  'eu-north-1':     { lat: 59.3,  lon: 18.1 },    // Stockholm
  'me-south-1':     { lat: 26.1,  lon: 50.6 },    // Bahrain
  'af-south-1':     { lat: -33.9, lon: 18.4 },    // Cape Town
  'ap-south-1':     { lat: 19.1,  lon: 72.9 },    // Mumbai
  'ap-southeast-1': { lat: 1.35,  lon: 103.8 },   // Singapore
  'ap-southeast-2': { lat: -33.9, lon: 151.2 },   // Sydney
  'ap-northeast-1': { lat: 35.7,  lon: 139.7 },   // Tokyo
  'ap-northeast-2': { lat: 37.6,  lon: 127.0 },   // Seoul
  'ap-northeast-3': { lat: 34.7,  lon: 135.5 },   // Osaka
  'ap-east-1':      { lat: 22.3,  lon: 114.2 },   // Hong Kong
}

const EARTH_RADIUS_KM = 6371

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}
