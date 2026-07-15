import type { TenantConfig } from './types.js';

export type TemplateContext = Record<string, string | number | boolean | null | undefined>;

export function renderTemplate(template: string, context: TemplateContext): string {
  let result = template;

  // Replace simple variables: {{variable}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = context[key];
    return value !== undefined && value !== null ? String(value) : '';
  });

  // Replace conditional blocks: {{#if condition}}...{{/if}}
  result = result.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, condition: string, block: string) => {
    const value = context[condition];
    return value ? block : '';
  });

  // Replace each blocks: {{#each items}}...{{/each}}
  result = result.replace(/\{\{#each (\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, arrayKey: string, block: string) => {
    const items = context[arrayKey];
    if (!Array.isArray(items)) return '';

    return items.map((item: Record<string, unknown>) => {
      let itemResult = block;
      if (typeof item === 'object' && item !== null) {
        for (const [key, value] of Object.entries(item)) {
          let strValue = '';
          if (value !== null && value !== undefined) {
            if (typeof value === 'object') {
              strValue = JSON.stringify(value);
            } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
              strValue = String(value);
            }
          }
          itemResult = itemResult.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), strValue);
        }
      } else {
        const strValue = item !== null && item !== undefined ? String(item) : '';
        itemResult = itemResult.replace(/\{\{this\}\}/g, strValue);
      }
      return itemResult;
    }).join('');
  });

  return result;
}

export function buildButtonsFromConfig(buttons: TenantConfig['botButtons']): Array<{ id: string; body: string }> {
  return buttons.map((btn) => ({
    id: btn.id,
    body: btn.label,
  }));
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatCurrency(amount: number): string {
  return `Rp ${Math.round(amount).toLocaleString('id-ID')}`;
}

export function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

export function bar(part: number, total: number, len = 10): string {
  if (total === 0) return '░'.repeat(len);
  const filled = Math.round((part / total) * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}
