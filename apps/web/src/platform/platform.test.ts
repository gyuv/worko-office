import { describe, expect, it } from 'vitest';
import { isPlatformHash } from './banner';

describe('platform console route', () => {
  it('only #/platform (and sub-paths) opens the super-admin console', () => {
    expect(isPlatformHash('#/platform')).toBe(true);
    expect(isPlatformHash('#/platform/tenants')).toBe(true);
    expect(isPlatformHash('#/platformx')).toBe(false);
    expect(isPlatformHash('#/settings/subscription')).toBe(false);
    expect(isPlatformHash('#/portal/demo')).toBe(false);
  });
});
