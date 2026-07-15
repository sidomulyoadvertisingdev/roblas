export type WhatsAppLifecycleState =
  | 'initializing'
  | 'qr_pending'
  | 'authenticated'
  | 'ready'
  | 'disconnected'
  | 'auth_failure'
  | 'error'
  | 'stopped';

export interface WhatsAppStatus {
  state: WhatsAppLifecycleState;
  ready: boolean;
  account: { id: string; name?: string } | null;
  expectedBotPhone: string | null;
  botPhoneMatches: boolean | null;
  lastError: string | null;
  updatedAt: string;
}

export interface SendMessageResult {
  messageId: string;
  to: string;
  timestamp: number;
}

export interface NumberValidationResult {
  input: string;
  normalized: string;
  whatsappId: string;
  registered: boolean;
}

export interface IncomingMessage {
  messageId: string;
  from: string;
  fromWhatsappId: string;
  body: string;
  timestamp: number;
  isGroup: boolean;
  hasMedia: boolean;
  type: string;
}

export type IncomingMessageHandler = (message: IncomingMessage) => void | Promise<void>;

export interface WhatsAppGateway {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  getStatus(): WhatsAppStatus;
  getQr(): string | null;
  sendMessage(phone: string, message: string): Promise<SendMessageResult>;
  sendToWhatsAppId(whatsappId: string, message: string): Promise<SendMessageResult>;
  sendButtonsToWhatsAppId(
    whatsappId: string,
    body: string,
    buttons: Array<{ id: string; body: string }>,
    title?: string,
    footer?: string,
  ): Promise<SendMessageResult>;
  sendDocumentToWhatsAppId(whatsappId: string, filePath: string, filename: string, caption?: string): Promise<SendMessageResult>;
  validateNumber(phone: string): Promise<NumberValidationResult>;
  setTyping?(phone: string, state: boolean): Promise<void>;
}
