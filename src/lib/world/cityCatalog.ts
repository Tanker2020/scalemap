// Pure catalog of major world cities (Polish 4 T7, spec D9): the globe's traffic-placement mode
// snaps a raw pointer lat/lon to the nearest entry here, so every placed population lands on a
// real, recognizable city rather than an arbitrary ocean coordinate. Same catalog spirit as
// REGION_GEO (regionGeo.ts) but for client populations, not datacenters — no relationship to
// WORLD_REGIONS; a city here need not have a region anywhere near it.
import { greatCircleKm } from './regionGeo'

export interface WorldCity {
  name: string
  lat: number
  lon: number
}

// ~48 cities spanning every inhabited continent (North America, South America, Europe, Africa,
// the Middle East, Asia, Oceania) — real coordinates, city-center precision (a few km of
// slop is irrelevant at globe scale). Alphabetical within each region grouping for scanability.
export const WORLD_CITIES: readonly WorldCity[] = [
  // North America
  { name: 'New York', lat: 40.7128, lon: -74.0060 },
  { name: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  { name: 'Chicago', lat: 41.8781, lon: -87.6298 },
  { name: 'Toronto', lat: 43.6532, lon: -79.3832 },
  { name: 'Mexico City', lat: 19.4326, lon: -99.1332 },
  { name: 'Vancouver', lat: 49.2827, lon: -123.1207 },
  { name: 'Miami', lat: 25.7617, lon: -80.1918 },
  { name: 'Seattle', lat: 47.6062, lon: -122.3321 },
  // South America
  { name: 'São Paulo', lat: -23.5505, lon: -46.6333 },
  { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816 },
  { name: 'Bogotá', lat: 4.7110, lon: -74.0721 },
  { name: 'Lima', lat: -12.0464, lon: -77.0428 },
  { name: 'Santiago', lat: -33.4489, lon: -70.6693 },
  // Europe
  { name: 'London', lat: 51.5074, lon: -0.1278 },
  { name: 'Paris', lat: 48.8566, lon: 2.3522 },
  { name: 'Berlin', lat: 52.5200, lon: 13.4050 },
  { name: 'Madrid', lat: 40.4168, lon: -3.7038 },
  { name: 'Rome', lat: 41.9028, lon: 12.4964 },
  { name: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
  { name: 'Stockholm', lat: 59.3293, lon: 18.0686 },
  { name: 'Warsaw', lat: 52.2297, lon: 21.0122 },
  { name: 'Dublin', lat: 53.3498, lon: -6.2603 },
  { name: 'Moscow', lat: 55.7558, lon: 37.6173 },
  { name: 'Istanbul', lat: 41.0082, lon: 28.9784 },
  { name: 'Athens', lat: 37.9838, lon: 23.7275 },
  // Africa
  { name: 'Cairo', lat: 30.0444, lon: 31.2357 },
  { name: 'Lagos', lat: 6.5244, lon: 3.3792 },
  { name: 'Nairobi', lat: -1.2921, lon: 36.8219 },
  { name: 'Cape Town', lat: -33.9249, lon: 18.4241 },
  { name: 'Johannesburg', lat: -26.2041, lon: 28.0473 },
  { name: 'Casablanca', lat: 33.5731, lon: -7.5898 },
  { name: 'Addis Ababa', lat: 9.0300, lon: 38.7400 },
  // Middle East
  { name: 'Dubai', lat: 25.2048, lon: 55.2708 },
  { name: 'Riyadh', lat: 24.7136, lon: 46.6753 },
  { name: 'Tel Aviv', lat: 32.0853, lon: 34.7818 },
  // Asia
  { name: 'Mumbai', lat: 19.0760, lon: 72.8777 },
  { name: 'Delhi', lat: 28.7041, lon: 77.1025 },
  { name: 'Singapore', lat: 1.3521, lon: 103.8198 },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  { name: 'Seoul', lat: 37.5665, lon: 126.9780 },
  { name: 'Shanghai', lat: 31.2304, lon: 121.4737 },
  { name: 'Beijing', lat: 39.9042, lon: 116.4074 },
  { name: 'Hong Kong', lat: 22.3193, lon: 114.1694 },
  { name: 'Bangkok', lat: 13.7563, lon: 100.5018 },
  { name: 'Jakarta', lat: -6.2088, lon: 106.8456 },
  { name: 'Manila', lat: 14.5995, lon: 120.9842 },
  // Oceania
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Auckland', lat: -36.8485, lon: 174.7633 },
]

// Argmin over great-circle distance — the raw pointer lat/lon (from GlobeScene's raycast) snaps
// to whichever catalog entry is physically nearest. WORLD_CITIES is never empty, so this always
// returns a real entry (no null case to plumb through every caller).
export function nearestCity(lat: number, lon: number): WorldCity {
  let best = WORLD_CITIES[0]
  let bestKm = greatCircleKm(lat, lon, best.lat, best.lon)
  for (let i = 1; i < WORLD_CITIES.length; i++) {
    const city = WORLD_CITIES[i]
    const km = greatCircleKm(lat, lon, city.lat, city.lon)
    if (km < bestKm) { best = city; bestKm = km }
  }
  return best
}
