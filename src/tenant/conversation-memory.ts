export interface ConversationTurn {
  user: string;
  assistant: string;
  timestamp: number;
}

interface MemoryEntry {
  turns: ConversationTurn[];
  updatedAt: number;
}

export class ConversationMemory {
  private entries = new Map<string, MemoryEntry>();

  constructor(private readonly ttlMs = 30 * 60 * 1000, private readonly maxTurns = 6) {}

  get(key: string): ConversationTurn[] {
    const entry = this.entries.get(key);
    if (!entry) return [];
    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.entries.delete(key);
      return [];
    }
    return [...entry.turns];
  }

  add(key: string, user: string, assistant: string): void {
    const turns = this.get(key);
    turns.push({ user: user.slice(0, 1000), assistant: assistant.slice(0, 2000), timestamp: Date.now() });
    this.entries.set(key, { turns: turns.slice(-this.maxTurns), updatedAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}
