import { describe, expect, it } from 'vitest';
import {
  renderTemplate,
  buildButtonsFromConfig,
  formatDate,
  formatCurrency,
  pct,
  bar,
} from '../src/tenant/template-engine.js';

describe('renderTemplate', () => {
  it('replaces simple variables', () => {
    const result = renderTemplate('Hello {{name}}, you have {{count}} messages', {
      name: 'Budi',
      count: 5,
    });
    expect(result).toBe('Hello Budi, you have 5 messages');
  });

  it('replaces missing variables with empty string', () => {
    const result = renderTemplate('Hello {{name}}', {});
    expect(result).toBe('Hello ');
  });

  it('handles conditional blocks - true', () => {
    const result = renderTemplate('{{#if active}}Active{{/if}}', { active: true });
    expect(result).toBe('Active');
  });

  it('handles conditional blocks - false', () => {
    const result = renderTemplate('{{#if active}}Active{{/if}}', { active: false });
    expect(result).toBe('');
  });

  it('handles each blocks with objects', () => {
    const result = renderTemplate('{{#each items}}- {{name}}: {{qty}}\n{{/each}}', {
      items: [
        { name: 'Item A', qty: 3 },
        { name: 'Item B', qty: 7 },
      ],
    });
    expect(result).toBe('- Item A: 3\n- Item B: 7\n');
  });

  it('handles each blocks with primitives', () => {
    const result = renderTemplate('{{#each tags}}[{{this}}]{{/each}}', {
      tags: ['wa', 'bot'],
    });
    expect(result).toBe('[wa][bot]');
  });

  it('handles nested conditionals inside each', () => {
    const result = renderTemplate('{{#each items}}{{#if active}}ON{{/if}} {{/each}}', {
      items: [{ active: true }, { active: false }],
    });
    expect(result).toBe('ON  ');
  });
});

describe('buildButtonsFromConfig', () => {
  it('maps config buttons to button format', () => {
    const buttons = [
      { id: 'dl', label: 'Download' },
      { id: 'rf', label: 'Refresh' },
    ];
    expect(buildButtonsFromConfig(buttons)).toEqual([
      { id: 'dl', body: 'Download' },
      { id: 'rf', body: 'Refresh' },
    ]);
  });

  it('returns empty array for empty config', () => {
    expect(buildButtonsFromConfig([])).toEqual([]);
  });
});

describe('formatDate', () => {
  it('formats YYYY-MM-DD to Indonesian date', () => {
    const result = formatDate('2026-07-16');
    expect(result).toMatch(/16 Juli 2026/);
  });
});

describe('formatCurrency', () => {
  it('formats number to IDR', () => {
    expect(formatCurrency(1500000)).toBe('Rp 1.500.000');
  });

  it('rounds decimal', () => {
    expect(formatCurrency(1500.7)).toBe('Rp 1.501');
  });
});

describe('pct', () => {
  it('calculates percentage', () => {
    expect(pct(3, 4)).toBe('75%');
  });

  it('handles zero total', () => {
    expect(pct(0, 0)).toBe('0%');
  });
});

describe('bar', () => {
  it('renders progress bar', () => {
    expect(bar(5, 10, 10)).toBe('█████░░░░░');
  });

  it('renders full bar', () => {
    expect(bar(10, 10, 10)).toBe('██████████');
  });

  it('renders empty bar for zero total', () => {
    expect(bar(0, 10, 5)).toBe('░░░░░');
  });

  it('renders partial bar', () => {
    expect(bar(3, 10, 10)).toBe('███░░░░░░░');
  });
});
