import { existsSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';
import { AppError } from '../errors/app-error.js';
import type { Logger } from '../logger.js';
import { normalizePhoneNumber, toWhatsAppId } from './phone.js';
import type {
  IncomingMessage,
  IncomingMessageHandler,
  NumberValidationResult,
  SendMessageResult,
  WhatsAppGateway,
  WhatsAppLifecycleState,
  WhatsAppStatus,
} from './types.js';

const { Client, LocalAuth } = whatsappWeb;
const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

export interface WhatsAppServiceOptions {
  clientId: string;
  authPath: string;
  headless: boolean;
  executablePath?: string;
  expectedBotPhone?: string;
  onIncomingMessage?: IncomingMessageHandler;
}

export class WhatsAppService implements WhatsAppGateway {
  private readonly client: InstanceType<typeof Client>;
  private readonly sessionDir: string;
  private readonly expectedBotPhone: string | null;
  private onIncomingMessage: IncomingMessageHandler | null;
  private state: WhatsAppLifecycleState = 'stopped';
  private qr: string | null = null;
  private lastError: string | null = null;
  private updatedAt = new Date();

  constructor(options: WhatsAppServiceOptions, private readonly logger: Logger) {
    this.expectedBotPhone = options.expectedBotPhone ? normalizePhoneNumber(options.expectedBotPhone) : null;
    this.onIncomingMessage = options.onIncomingMessage ?? null;
    this.sessionDir = path.resolve(options.authPath, `session-${options.clientId}`);
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: options.clientId, dataPath: options.authPath }),
      puppeteer: {
        headless: options.headless,
        protocolTimeout: 120000,
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });
    this.bindEvents();
  }

  private setState(state: WhatsAppLifecycleState, error: string | null = null): void {
    this.state = state;
    this.lastError = error;
    this.updatedAt = new Date();
  }

  private bindEvents(): void {
    this.client.on('qr', (qr) => {
      this.qr = qr;
      this.setState('qr_pending');
      this.logger.info({ event: 'whatsapp_qr' }, 'WhatsApp QR code generated');
      qrcode.generate(qr, { small: true });
    });
    this.client.on('authenticated', () => {
      this.qr = null;
      this.setState('authenticated');
      this.logger.info({ event: 'whatsapp_authenticated' }, 'WhatsApp authenticated');
    });
    this.client.on('ready', () => {
      this.qr = null;
      this.setState('ready');
      const info = this.client.info;
      const connectedPhone = info?.wid.user;
      if (this.expectedBotPhone && connectedPhone && connectedPhone !== this.expectedBotPhone) {
        this.logger.warn(
          { event: 'whatsapp_bot_phone_mismatch', expected: this.expectedBotPhone, connected: connectedPhone },
          'Connected WhatsApp number does not match WA_BOT_PHONE',
        );
      }
      this.logger.info({ event: 'whatsapp_ready', connected: connectedPhone }, 'WhatsApp client ready');
      this.bindMessageListener();
    });
    this.client.on('auth_failure', (message) => {
      this.setState('auth_failure', message);
      this.logger.error({ event: 'whatsapp_auth_failure', reason: message }, 'WhatsApp authentication failed');
    });
    this.client.on('disconnected', (reason) => {
      this.setState('disconnected', String(reason));
      this.logger.warn({ event: 'whatsapp_disconnected', reason }, 'WhatsApp disconnected');
    });
  }

  private bindMessageListener(): void {
    if (!this.onIncomingMessage) return;
    this.client.on('message', (message) => {
      this.logger.info({ event: 'raw_message_received', from: message.from, fromMe: message.fromMe, body: message.body?.slice(0, 50), type: message.type }, 'Raw message event fired');
      void this.handleIncoming(message);
    });
    this.logger.info({ event: 'message_listener_bound' }, 'Message event listener bound');
  }

  private async handleIncoming(message: whatsappWeb.Message): Promise<void> {
    if (!this.onIncomingMessage) return;
    if (message.fromMe) return;
    try {
      let isGroup = false;
      try {
        const chat = await message.getChat();
        isGroup = chat.isGroup;
      } catch {
        this.logger.debug({ event: 'get_chat_failed', from: message.from }, 'Failed to get chat info; assuming non-group');
      }
      const senderId = message.author || message.from;
      const sender = await this.resolveSenderIdentity(message, senderId);
      const payload: IncomingMessage = {
        messageId: message.id._serialized,
        from: sender.phone,
        // Reply to the chat ID, which may intentionally remain an @lid address.
        fromWhatsappId: message.from,
        ...(sender.name ? { senderName: sender.name } : {}),
        body: message.body,
        timestamp: message.timestamp,
        isGroup,
        hasMedia: message.hasMedia,
        type: message.type,
      };
      await this.onIncomingMessage(payload);
    } catch (error) {
      this.logger.error({ err: error, event: 'incoming_message_handler_failed' }, 'Incoming handler failed');
    }
  }

  private async resolveSenderIdentity(
    message: whatsappWeb.Message,
    senderId: string,
  ): Promise<{ phone: string; name: string | null }> {
    let phone = senderId.split('@')[0] ?? '';
    let name: string | null = null;

    try {
      const contact = await message.getContact();
      name = contact.pushname || contact.name || contact.shortName || null;
      if (!senderId.endsWith('@lid') && contact.number) phone = contact.number;
    } catch (error) {
      this.logger.debug({ err: error, event: 'sender_contact_resolution_failed', senderId }, 'Failed to resolve sender contact');
    }

    if (!senderId.endsWith('@lid')) return { phone, name };

    try {
      const [mapping] = await this.client.getContactLidAndPhone([senderId]);
      if (mapping?.pn) {
        phone = mapping.pn.split('@')[0] ?? '';
        this.logger.debug({ event: 'lid_sender_resolved', lid: senderId, phone }, 'Resolved LID sender to phone number');
      }
    } catch (error) {
      this.logger.warn({ err: error, event: 'lid_sender_resolution_failed', lid: senderId }, 'Failed to resolve LID sender');
    }

    return { phone, name };
  }

  async initialize(): Promise<void> {
    this.setState('initializing');
    await this.cleanSingletonLocks();
    try {
      await this.client.initialize();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState('error', message);
      this.logger.error({ err: error }, 'Unable to initialize WhatsApp client');
      throw error;
    }
  }

  private async cleanSingletonLocks(): Promise<void> {
    if (!existsSync(this.sessionDir)) return;
    for (const name of LOCK_FILES) {
      const target = path.join(this.sessionDir, name);
      if (!existsSync(target)) continue;
      try {
        await unlink(target);
        this.logger.warn({ event: 'chromium_lock_cleaned', file: name }, 'Removed stale Chromium lock file');
      } catch (error) {
        this.logger.debug({ err: error, file: name }, 'Failed to remove Chromium lock (may be in use)');
      }
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.client.destroy();
    } finally {
      this.qr = null;
      this.setState('stopped');
      this.logger.info('WhatsApp client stopped');
    }
  }

  async cleanupSession(): Promise<void> {
    try {
      await this.client.logout();
      this.logger.info({ event: 'whatsapp_logout' }, 'WhatsApp logged out (device unlinked)');
    } catch (error) {
      this.logger.warn({ err: error, event: 'whatsapp_logout_failed' }, 'Logout failed; cleaning session files anyway');
    }
    try {
      if (existsSync(this.sessionDir)) {
        await rm(this.sessionDir, { recursive: true, force: true });
        this.logger.info({ event: 'session_dir_removed', path: this.sessionDir }, 'Session directory removed');
      }
    } catch (error) {
      this.logger.error({ err: error, event: 'session_cleanup_failed' }, 'Failed to remove session directory');
    }
    this.qr = null;
    this.setState('stopped');
  }

  getStatus(): WhatsAppStatus {
    const info = this.client.info;
    const connectedPhone = info?.wid.user ?? null;
    return {
      state: this.state,
      ready: this.state === 'ready',
      account: info
        ? { id: info.wid._serialized, ...(info.pushname ? { name: info.pushname } : {}) }
        : null,
      expectedBotPhone: this.expectedBotPhone,
      botPhoneMatches: this.expectedBotPhone === null
        ? null
        : connectedPhone !== null && connectedPhone === this.expectedBotPhone,
      lastError: this.lastError,
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  getQr(): string | null {
    return this.qr;
  }

  replaceMessageHandler(handler: IncomingMessageHandler): void {
    this.onIncomingMessage = handler;
  }

  private ensureReady(): void {
    if (this.state !== 'ready') {
      throw new AppError(503, 'WhatsApp client is not ready', 'WHATSAPP_NOT_READY', { state: this.state });
    }
  }

  async validateNumber(phone: string): Promise<NumberValidationResult> {
    this.ensureReady();
    const normalized = normalizePhoneNumber(phone);
    const whatsappId = toWhatsAppId(normalized);
    const registered = await this.client.isRegisteredUser(whatsappId);
    return { input: phone, normalized, whatsappId, registered };
  }

  async sendMessage(phone: string, message: string): Promise<SendMessageResult> {
    this.ensureReady();
    const validation = await this.validateNumber(phone);
    if (!validation.registered) {
      throw new AppError(422, 'Phone number is not registered on WhatsApp', 'NUMBER_NOT_REGISTERED');
    }
    const sent = await this.client.sendMessage(validation.whatsappId, message);
    if (!sent || typeof sent !== 'object') {
      this.logger.warn(
        { event: 'send_message_no_ack', to: validation.normalized },
        'WhatsApp sendMessage returned no message reference (message may still have been sent)',
      );
      return {
        messageId: `local-${Date.now().toString()}`,
        to: validation.normalized,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
    return {
      messageId: sent.id?._serialized ?? `local-${Date.now().toString()}`,
      to: validation.normalized,
      timestamp: sent.timestamp ?? Math.floor(Date.now() / 1000),
    };
  }

  async sendToWhatsAppId(whatsappId: string, message: string): Promise<SendMessageResult> {
    this.ensureReady();
    const sent = await this.client.sendMessage(whatsappId, message);
    if (!sent || typeof sent !== 'object') {
      this.logger.warn(
        { event: 'send_message_no_ack', whatsappId },
        'WhatsApp sendMessage returned no message reference (message may still have been sent)',
      );
      return {
        messageId: `local-${Date.now().toString()}`,
        to: whatsappId,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
    return {
      messageId: sent.id?._serialized ?? `local-${Date.now().toString()}`,
      to: whatsappId,
      timestamp: sent.timestamp ?? Math.floor(Date.now() / 1000),
    };
  }

  async sendDocumentToWhatsAppId(whatsappId: string, filePath: string, filename: string, caption?: string): Promise<SendMessageResult> {
    this.ensureReady();
    const media = whatsappWeb.MessageMedia.fromFilePath(filePath);
    const opts: Record<string, unknown> = { filename };
    if (caption) opts.caption = caption;
    const sent = await this.client.sendMessage(whatsappId, media, opts);
    if (!sent || typeof sent !== 'object') {
      this.logger.warn(
        { event: 'send_document_no_ack', whatsappId, filename },
        'WhatsApp sendDocument returned no message reference',
      );
      return {
        messageId: `local-${Date.now().toString()}`,
        to: whatsappId,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
    return {
      messageId: sent.id?._serialized ?? `local-${Date.now().toString()}`,
      to: whatsappId,
      timestamp: sent.timestamp ?? Math.floor(Date.now() / 1000),
    };
  }

  async sendButtonsToWhatsAppId(
    whatsappId: string,
    body: string,
    buttons: Array<{ id: string; body: string }>,
    title?: string,
    footer?: string,
  ): Promise<SendMessageResult> {
    this.ensureReady();
    const btnObj = new whatsappWeb.Buttons(body, buttons, title, footer);
    const sent = await this.client.sendMessage(whatsappId, btnObj);
    if (!sent || typeof sent !== 'object') {
      this.logger.warn(
        { event: 'send_buttons_no_ack', whatsappId },
        'WhatsApp sendButtons returned no message reference',
      );
      return {
        messageId: `local-${Date.now().toString()}`,
        to: whatsappId,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
    return {
      messageId: sent.id?._serialized ?? `local-${Date.now().toString()}`,
      to: whatsappId,
      timestamp: sent.timestamp ?? Math.floor(Date.now() / 1000),
    };
  }

  async setTyping(phone: string, state: boolean): Promise<void> {
    this.ensureReady();
    const whatsappId = toWhatsAppId(phone);
    const chat = await this.client.getChatById(whatsappId);
    if (state) {
      await chat.sendStateTyping();
    } else {
      await chat.clearState();
    }
  }
}
