import { describe, expect, it } from 'vitest';
import { normaliseServer } from './server';

describe('normaliseServer', () => {
  it('accepts bare hosts and full URLs, defaulting to /v1 over https', () => {
    expect(normaliseServer('worko-api.onrender.com')).toBe('https://worko-api.onrender.com/v1');
    expect(normaliseServer(' https://api.firm.in/v1/ ')).toBe('https://api.firm.in/v1');
    expect(normaliseServer('https://api.firm.in/custom')).toBe('https://api.firm.in/custom');
    expect(normaliseServer('http://10.0.2.2:3000/v1')).toBe('http://10.0.2.2:3000/v1');
  });
  it('rejects empty, junk and plain-http public hosts', () => {
    expect(normaliseServer('')).toBeNull();
    expect(normaliseServer('http://evil.example')).toBeNull();
    expect(normaliseServer('ftp://x')).toBeNull();
  });
});
