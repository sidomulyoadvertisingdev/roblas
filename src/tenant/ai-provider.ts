import type { Logger } from '../logger.js';
import type { TenantAiConfig } from './types.js';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: GroqUsage;
}

export interface AiResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | undefined;
}

export interface AiProvider {
  chat(messages: AiMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<AiResponse>;
}

export class GroqProvider implements AiProvider {
  private apiKey: string;
  private model: string;
  private logger: Logger;

  constructor(apiKey: string, model: string, logger: Logger) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
  }

  async chat(messages: AiMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<AiResponse> {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens ?? 256,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error({ event: 'groq_api_error', status: response.status, body: text.slice(0, 200) }, 'Groq API request failed');
      throw new Error(`Groq API error: ${response.status}`);
    }

    const body = await response.json() as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content ?? '';

    return {
      content,
      usage: body.usage ? {
        promptTokens: body.usage.prompt_tokens,
        completionTokens: body.usage.completion_tokens,
        totalTokens: body.usage.total_tokens,
      } : undefined,
    };
  }
}

export class OpenAiProvider implements AiProvider {
  private apiKey: string;
  private model: string;
  private logger: Logger;

  constructor(apiKey: string, model: string, logger: Logger) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
  }

  async chat(messages: AiMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<AiResponse> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens ?? 256,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error({ event: 'openai_api_error', status: response.status, body: text.slice(0, 200) }, 'OpenAI API request failed');
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const body = await response.json() as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content ?? '';

    return {
      content,
      usage: body.usage ? {
        promptTokens: body.usage.prompt_tokens,
        completionTokens: body.usage.completion_tokens,
        totalTokens: body.usage.total_tokens,
      } : undefined,
    };
  }
}

export class CustomProvider implements AiProvider {
  private apiKey: string;
  private model: string;
  private logger: Logger;

  constructor(apiKey: string, model: string, logger: Logger) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
  }

  async chat(messages: AiMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<AiResponse> {
    const response = await fetch(this.model, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        messages,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens ?? 256,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error({ event: 'custom_api_error', status: response.status, body: text.slice(0, 200) }, 'Custom API request failed');
      throw new Error(`Custom API error: ${response.status}`);
    }

    const body = await response.json() as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content ?? '';

    return {
      content,
      usage: body.usage ? {
        promptTokens: body.usage.prompt_tokens,
        completionTokens: body.usage.completion_tokens,
        totalTokens: body.usage.total_tokens,
      } : undefined,
    };
  }
}

export function createAiProvider(aiConfig: TenantAiConfig, logger: Logger): AiProvider | null {
  if (!aiConfig.apiKey) return null;

  switch (aiConfig.provider) {
    case 'groq':
      return new GroqProvider(aiConfig.apiKey, aiConfig.model, logger);
    case 'openai':
      return new OpenAiProvider(aiConfig.apiKey, aiConfig.model, logger);
    case 'custom':
      return new CustomProvider(aiConfig.apiKey, aiConfig.model, logger);
    default:
      return null;
  }
}
