export type ToolRisk = 'read' | 'low' | 'medium' | 'critical';

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export class PolicyEngine {
  evaluate(risk: ToolRisk): PolicyDecision {
    if (risk === 'critical') {
      return {
        allowed: false,
        reason: 'critical writes are blocked by default',
      };
    }

    return {
      allowed: true,
      reason: `${risk} tool allowed by default policy`,
    };
  }
}
