import { ActionProposalSchema, type ActionProposal } from './action-policy.js';

export interface ActionProposalQuery {
  status?: ActionProposal['status'];
  limit?: number;
}

export interface ActionProposalStore {
  append(proposal: ActionProposal): Promise<ActionProposal>;
  list(query?: ActionProposalQuery): Promise<ActionProposal[]>;
  findById(id: string): Promise<ActionProposal | undefined>;
}

function clone(proposal: ActionProposal): ActionProposal {
  return structuredClone(proposal);
}

export class InMemoryActionProposalStore implements ActionProposalStore {
  private readonly proposals: ActionProposal[] = [];

  async append(proposal: ActionProposal): Promise<ActionProposal> {
    const validated = ActionProposalSchema.parse(proposal);
    const existing = this.proposals.find((item) => item.id === validated.id);
    if (existing) return clone(existing);
    this.proposals.push(clone(validated));
    return clone(validated);
  }

  async list(query: ActionProposalQuery = {}): Promise<ActionProposal[]> {
    const limit = query.limit ?? 100;
    return this.proposals
      .filter((item) => !query.status || item.status === query.status)
      .slice()
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .slice(0, limit)
      .map(clone);
  }

  async findById(id: string): Promise<ActionProposal | undefined> {
    const found = this.proposals.find((item) => item.id === id);
    return found ? clone(found) : undefined;
  }
}
