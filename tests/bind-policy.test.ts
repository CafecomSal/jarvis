import { describe, expect, it } from 'vitest';
import { bindPolicy } from '../src/network/bind-policy.js';

describe('política de rede Tailscale-only', () => {
  it('permite apenas bind local para ser servido pelo proxy Tailscale', () => {
    expect(bindPolicy('127.0.0.1')).toMatchObject({ allowed: true, exposure: 'tailscale-only', bind: 'loopback' });
    expect(bindPolicy('localhost')).toMatchObject({ allowed: true, exposure: 'tailscale-only' });
  });

  it('rejeita bind público ou curinga', () => {
    expect(bindPolicy('0.0.0.0')).toMatchObject({ allowed: false, exposure: 'public' });
    expect(bindPolicy('192.168.2.9')).toMatchObject({ allowed: false, exposure: 'private' });
  });
});
