import type { Logger } from '../logger.js';
import type { IncomingMessage, IncomingMessageHandler, WhatsAppGateway } from '../whatsapp/types.js';
import type { ResolvedTenant } from './types.js';
import { createAiProvider } from './ai-provider.js';
import { renderTemplate, buildButtonsFromConfig } from './template-engine.js';
import { BackendClient } from './backend-client.js';

export interface GenericBotHandlerOptions {
  getTenant: (fromWhatsappId: string) => Promise<ResolvedTenant | null>;
  fallbackHandler: IncomingMessageHandler;
}

export interface ParsedIntent {
  intent: string;
  params: Record<string, unknown>;
}

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah asisten AI. Return HANYA JSON valid.
Schema: { "intent": string, "params": {} }
Aturan:
- Jika user minta bantuan → intent: "help"
- Jika user ingin lihat menu → intent: "menu"
- Jika user ingin pesan/order → intent: "order"
- Jika user ingin cek status → intent: "status"
- Default → intent: "chat"`;

export function createGenericBotHandler(
  whatsapp: WhatsAppGateway,
  logger: Logger,
  options: GenericBotHandlerOptions,
): IncomingMessageHandler {
  return async (message: IncomingMessage): Promise<void> => {
    if (message.isGroup) {
      return options.fallbackHandler(message);
    }

    const resolved = await options.getTenant(message.fromWhatsappId);
    if (!resolved || !resolved.config.botEnabled) {
      return options.fallbackHandler(message);
    }

    const { tenant, config, aiConfig } = resolved;
    const lower = message.body.trim().toLowerCase();

    logger.info({ event: 'bot_message_received', tenantId: tenant.id, from: message.from, body: message.body.slice(0, 100) }, 'Bot processing message');

    const reply = (text: string) => whatsapp.sendToWhatsAppId(message.fromWhatsappId, text);
    const sendButtons = (body: string, buttons: Array<{ id: string; body: string }>, title?: string, footer?: string) =>
      whatsapp.sendButtonsToWhatsAppId(message.fromWhatsappId, body, buttons, title, footer);

    try {
      // Handle button clicks directly
      if (lower === 'help' || lower === 'bantuan' || lower === 'menu') {
        const greeting = config.botGreeting || `Halo! Selamat datang.`;
        await reply(greeting);
        return;
      }

      // Check trigger keywords
      if (config.botTriggerKeywords.length > 0) {
        const hasTrigger = config.botTriggerKeywords.some((kw) => lower.includes(kw.toLowerCase()));
        if (!hasTrigger) {
          return options.fallbackHandler(message);
        }
      }

      // Parse intent with AI
      const provider = createAiProvider(aiConfig, logger);
      if (!provider) {
        await reply(config.botUnknownReply);
        return;
      }

      const systemPrompt = aiConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      const today = new Date().toISOString().slice(0, 10);
      const fullPrompt = systemPrompt.replace('{TODAY}', today);

      const aiResponse = await provider.chat([
        { role: 'system', content: fullPrompt },
        { role: 'user', content: message.body },
      ], { temperature: 0, maxTokens: aiConfig.maxTokens });

      let parsed: ParsedIntent;
      try {
        parsed = JSON.parse(aiResponse.content) as ParsedIntent;
      } catch {
        parsed = { intent: 'chat', params: {} };
      }

      logger.info({ event: 'bot_intent_parsed', tenantId: tenant.id, intent: parsed.intent }, 'AI parsed intent');

      // Handle intents
      if (parsed.intent === 'help' || parsed.intent === 'menu') {
        const greeting = config.botGreeting || `Halo! Selamat datang.`;
        await reply(greeting);
        return;
      }

      // For other intents, try to call backend
      if (config.webhookUrl) {
        const backend = new BackendClient({ config, logger });
        const response = await backend.fetch('/webhook', {
          method: 'POST',
          body: {
            intent: parsed.intent,
            params: parsed.params,
            message: message.body,
            from: message.from,
            timestamp: message.timestamp,
          },
        });

        if (response.success && response.data) {
          // Use response template if available
          if (aiConfig.responseTemplate) {
            const context: Record<string, string | number | boolean | null | undefined> = response.data as Record<string, string | number | boolean | null | undefined>;
            const rendered = renderTemplate(aiConfig.responseTemplate, context);
            await reply(rendered);
          } else if (typeof response.data === 'string') {
            await reply(response.data);
          } else {
            await reply(JSON.stringify(response.data, null, 2));
          }

          // Send buttons if configured
          if (config.botButtons.length > 0) {
            const buttons = buildButtonsFromConfig(config.botButtons);
            await sendButtons('Pilih aksi:', buttons, undefined, tenant.name);
          }

          return;
        }
      }

      // Fallback to unknown reply
      await reply(config.botUnknownReply);
    } catch (error) {
      logger.error({ err: error, event: 'bot_handler_error', tenantId: tenant.id }, 'Bot handler failed');
      await reply('Terjadi kesalahan. Silakan coba lagi nanti.');
    }
  };
}
