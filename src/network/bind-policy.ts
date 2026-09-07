export interface BindPolicyResult {
  allowed: boolean;
  exposure: 'tailscale-only' | 'private' | 'public' | 'unknown';
  bind: 'loopback' | 'private' | 'public' | 'unknown';
  reason: string;
}

export function bindPolicy(host: string): BindPolicyResult {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return { allowed: true, exposure: 'tailscale-only', bind: 'loopback', reason: 'loopback can be exposed through Tailscale Serve' };
  }
  if (normalized === '0.0.0.0' || normalized === '::') {
    return { allowed: false, exposure: 'public', bind: 'public', reason: 'wildcard bind would bypass the Tailscale-only boundary' };
  }
  if (normalized) {
    return { allowed: false, exposure: 'private', bind: 'private', reason: 'direct network bind is not allowed by the Tailscale-only policy' };
  }
  return { allowed: false, exposure: 'unknown', bind: 'unknown', reason: 'bind host must not be empty' };
}
