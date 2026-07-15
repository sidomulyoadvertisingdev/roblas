export interface LogEntry {
  seq: number;
  time: string;
  level: string;
  msg: string;
  extra?: Record<string, unknown>;
}

export interface SendHistoryEntry {
  seq: number;
  time: string;
  phone: string;
  message: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export class RingBuffer<T extends { seq: number }> {
  private items: T[] = [];
  private nextSeq = 1;
  private readonly listeners = new Set<(entry: T) => void>();

  constructor(private readonly limit: number) {}

  push(item: Omit<T, 'seq'>): T {
    const entry = { ...item, seq: this.nextSeq++ } as T;
    this.items.push(entry);
    if (this.items.length > this.limit) this.items.shift();
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* ignore listener errors */
      }
    }
    return entry;
  }

  list(afterSeq = 0): T[] {
    if (afterSeq <= 0) return [...this.items];
    return this.items.filter((entry) => entry.seq > afterSeq);
  }

  subscribe(listener: (entry: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const logBuffer = new RingBuffer<LogEntry>(500);
export const sendHistory = new RingBuffer<SendHistoryEntry>(100);
