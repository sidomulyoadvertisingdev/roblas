export interface Tenant {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  plan: 'free' | 'pro' | 'enterprise' | undefined;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantWaAccount {
  id: string;
  tenantId: string;
  clientId: string;
  phone: string;
  displayName: string | null;
  isActive: boolean;
  authSessionPath: string;
  lastReadyAt: Date | null;
}

export interface TenantConfig {
  webhookUrl: string | null;
  webhookAuthMode: 'hmac' | 'bearer' | 'none';
  webhookSecret: string | null;
  webhookBearerToken: string | null;
  webhookTimeoutMs: number;
  webhookIgnoreGroups: boolean;
  webhookAllowedSenders: string[];
  webhookDiscoveredProfile: Record<string, unknown> | null;
  botEnabled: boolean;
  botTriggerKeywords: string[];
  botGreeting: string | null;
  botUnknownReply: string;
  botGroupBehavior: 'skip' | 'forward' | 'reply';
  botButtons: Array<{ id: string; label: string }>;
  excelColumns: Array<{ field: string; header: string; width: number }>;
}

export interface TenantAiConfig {
  provider: 'groq' | 'openai' | 'custom';
  apiKey: string | null;
  model: string;
  systemPrompt: string | null;
  businessKnowledge: string | null;
  webhookSchema: Record<string, unknown> | null;
  responseTemplate: string | null;
  responseInstructions: string | null;
  maxTokens: number;
}

export interface TenantApiKey {
  id: string;
  tenantId: string;
  keyHash: string;
  keyPrefix: string;
  permissions: string[];
  expiresAt: Date | null;
  isActive: boolean;
}

export interface ResolvedTenant {
  tenant: Tenant;
  waAccount: TenantWaAccount;
  config: TenantConfig;
  aiConfig: TenantAiConfig;
}

export const DEFAULT_TENANT_CONFIG: TenantConfig = {
  webhookUrl: null,
  webhookAuthMode: 'none',
  webhookSecret: null,
  webhookBearerToken: null,
  webhookTimeoutMs: 8000,
  webhookIgnoreGroups: true,
  webhookAllowedSenders: [],
  webhookDiscoveredProfile: null,
  botEnabled: false,
  botTriggerKeywords: [],
  botGreeting: null,
  botUnknownReply: 'Maaf, saya tidak mengerti. Ketik "help" untuk bantuan.',
  botGroupBehavior: 'skip',
  botButtons: [],
  excelColumns: [],
};

export const DEFAULT_AI_CONFIG: TenantAiConfig = {
  provider: 'groq',
  apiKey: null,
  model: 'llama-3.1-8b-instant',
  systemPrompt: null,
  businessKnowledge: null,
  webhookSchema: null,
  responseTemplate: null,
  responseInstructions: null,
  maxTokens: 256,
};
