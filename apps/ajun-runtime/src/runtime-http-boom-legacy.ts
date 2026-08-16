import crypto from 'node:crypto';
import { isLocalAddress } from './lan-access.ts';

export function isBoomLegacyIntegrationAuthorized({ remoteAddress, authorization, expectedToken }: any): boolean {
  if (isLocalAddress(remoteAddress)) return true;
  const supplied = bearerToken(authorization);
  const expected = String(expectedToken || '');
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function isBoomLegacyIntegrationPath(url: any): boolean {
  return [
    '/api/integrations/boom-monitor/health',
    '/api/integrations/boom-monitor/dispatch',
    '/api/integrations/boom-monitor/metrics',
  ].includes(String(url || ''));
}

export function bearerToken(value: any): string {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
