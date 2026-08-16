import { normalizedProductMaturityContext } from './workflow/mission-child-policy.ts';

export function normalizeBusinessMissionContext(value: any): any {
  const productMaturity = normalizedProductMaturityContext(value);
  if (productMaturity) return productMaturity;
  const signal = value?.boomSignal;
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return undefined;
  const serialized = JSON.stringify(signal);
  if (serialized.length > 12_000) return undefined;
  return { boomSignal:JSON.parse(serialized) };
}
