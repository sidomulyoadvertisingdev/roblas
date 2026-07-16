import { describe, expect, it, vi } from 'vitest';
import { ConversationMemory } from '../src/tenant/conversation-memory.js';

describe('ConversationMemory', () => {
  it('keeps only recent turns', () => {
    const memory = new ConversationMemory(60_000, 2);
    memory.add('key', 'one', 'a');
    memory.add('key', 'two', 'b');
    memory.add('key', 'three', 'c');
    expect(memory.get('key').map((turn) => turn.user)).toEqual(['two', 'three']);
  });

  it('expires old conversations', () => {
    vi.useFakeTimers();
    const memory = new ConversationMemory(1000);
    memory.add('key', 'hello', 'hi');
    vi.advanceTimersByTime(1001);
    expect(memory.get('key')).toEqual([]);
    vi.useRealTimers();
  });
});
