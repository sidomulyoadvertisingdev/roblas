import type { Logger } from '../logger.js';
import type { IncomingMessage, IncomingMessageHandler, WhatsAppGateway } from '../whatsapp/types.js';
import { parseMessage, type ParsedIntent } from './groq-client.js';
import { fetchReport, type AttendanceReport } from './attendance-client.js';
import { formatReport, HELP_TEXT } from './prompts.js';
import { generateAttendanceExcel, cleanupExcelFile } from './excel-export.js';
import type { WebhookRuntimeConfig } from '../webhook/types.js';

export interface BotHandlerOptions {
  groqApiKey: string;
  groqModel: string;
  getWebhookConfig: () => WebhookRuntimeConfig;
}

// Cache last query per user for "Refresh Data" button
const lastQueryCache = new Map<string, { dateFrom: string; dateTo: string; parsed: ParsedIntent; ts: number }>();

export interface BotHandlerOptions {
  groqApiKey: string;
  groqModel: string;
  getWebhookConfig: () => WebhookRuntimeConfig;
}

const isBotMessage = (body: string): boolean => {
  const lower = body.trim().toLowerCase();
  if (lower.startsWith('/')) return true;
  // Handle button clicks
  if (lower === 'download excel' || lower === 'refresh data' || lower === 'lihat menu') return true;
  const keywords = [
    'laporan', 'absen', 'rekap', 'kehadiran', 'izin', 'alpha',
    'gaji', 'lembur', 'hadir', 'karyawan', 'telat', 'terlambat',
    'siapa', 'berapa', 'berapa orang', 'berapa kali',
    'download', 'unduh', 'excel', 'file', 'export', 'ekspor',
    'help', 'bantuan', 'menu', 'command',
    'sakit', 'cuti', 'bolos', 'tidak masuk', 'ga masuk',
  ];
  return keywords.some((kw) => lower.includes(kw));
};

const resolveDates = (parsed: ParsedIntent): { dateFrom: string; dateTo: string } => {
  const today = new Date();
  const toStr = (d: Date) => d.toISOString().slice(0, 10);

  if (parsed.period === 'today') return { dateFrom: toStr(today), dateTo: toStr(today) };
  if (parsed.period === 'yesterday') {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    return { dateFrom: toStr(y), dateTo: toStr(y) };
  }
  if (parsed.period === 'this_week') {
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay() + 1);
    return { dateFrom: toStr(start), dateTo: toStr(today) };
  }
  if (parsed.period === 'this_month') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { dateFrom: toStr(start), dateTo: toStr(today) };
  }
  if (parsed.period === 'last_month') {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { dateFrom: toStr(start), dateTo: toStr(end) };
  }
  if (parsed.period === 'custom' && parsed.dateFrom && parsed.dateTo) {
    return { dateFrom: parsed.dateFrom, dateTo: parsed.dateTo };
  }

  if (parsed.dateFrom && parsed.dateTo) {
    return { dateFrom: parsed.dateFrom, dateTo: parsed.dateTo };
  }

  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  return { dateFrom: toStr(start), dateTo: toStr(today) };
};

export const createBotHandler = (
  whatsapp: WhatsAppGateway,
  logger: Logger,
  options: BotHandlerOptions,
  fallbackHandler: IncomingMessageHandler,
): IncomingMessageHandler => {
  return async (message: IncomingMessage): Promise<void> => {
    if (message.isGroup) {
      return fallbackHandler(message);
    }

    if (!isBotMessage(message.body)) {
      return fallbackHandler(message);
    }

    logger.info({ event: 'bot_message_received', from: message.from, body: message.body.slice(0, 100) }, 'Bot processing message');

    const reply = (text: string) => whatsapp.sendToWhatsAppId(message.fromWhatsappId, text);
    const sendFile = (filePath: string, filename: string, caption?: string) =>
      whatsapp.sendDocumentToWhatsAppId(message.fromWhatsappId, filePath, filename, caption);
    const sendButtons = (body: string, buttons: Array<{ id: string; body: string }>, title?: string, footer?: string) =>
      whatsapp.sendButtonsToWhatsAppId(message.fromWhatsappId, body, buttons, title, footer);

    try {
      const lowerBody = message.body.trim().toLowerCase();

      // Handle button clicks directly
      if (lowerBody === 'lihat menu') {
        await reply(HELP_TEXT);
        return;
      }

      const webhookConfig = options.getWebhookConfig();
      if (!webhookConfig.url || !webhookConfig.bearerToken) {
        await reply('Konfigurasi webhook belum lengkap. Hubungi admin.');
        return;
      }

      if (lowerBody === 'refresh data') {
        const cached = lastQueryCache.get(message.fromWhatsappId);
        if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
          const report = await fetchReport(webhookConfig.url, webhookConfig.bearerToken, cached.dateFrom, cached.dateTo, logger);
          if (report && report.rows.length > 0) {
            const response = formatReport(report, cached.parsed);
            await reply(response);
            await sendButtons(
              'Pilih aksi:',
              [
                { id: 'export_excel', body: 'Download Excel' },
                { id: 'refresh', body: 'Refresh Data' },
                { id: 'help', body: 'Lihat Menu' },
              ],
              undefined,
              'Bot Absensi',
            );
            return;
          }
        }
        await reply('Tidak ada data sebelumnya. Kirim pesan baru untuk melihat laporan.');
        return;
      }

      const parsed = await parseMessage(message.body, options.groqApiKey, options.groqModel, logger);
      logger.info({ event: 'bot_intent_parsed', intent: parsed.intent, period: parsed.period, employeeName: parsed.employeeName }, 'Groq AI parsed intent');

      if (parsed.intent === 'help') {
        await reply(HELP_TEXT);
        return;
      }

      if (parsed.intent === 'unknown') {
        await reply('Maaf, saya tidak mengerti. Kirim "help" untuk melihat daftar command.');
        return;
      }

      const { dateFrom, dateTo } = resolveDates(parsed);
      logger.info({ event: 'bot_fetching_report', dateFrom, dateTo }, 'Fetching attendance report');

      const report = await fetchReport(webhookConfig.url, webhookConfig.bearerToken, dateFrom, dateTo, logger);

      if (!report) {
        await reply('Gagal mengambil data absensi. Silakan coba lagi nanti.');
        return;
      }

      if (report.rows.length === 0) {
        await reply(`Tidak ada data absensi untuk periode ${dateFrom} s/d ${dateTo}.`);
        return;
      }

      // Cache for "Refresh Data" button
      lastQueryCache.set(message.fromWhatsappId, { dateFrom, dateTo, parsed, ts: Date.now() });

      if (parsed.intent === 'export_excel') {
        await reply('📊 Membuat file Excel, mohon tunggu...');
        const filePath = await generateAttendanceExcel(report, dateFrom, dateTo);
        const filename = `laporan-kehadiran-${dateFrom}-sd-${dateTo}.xlsx`;
        await sendFile(filePath, filename, `Laporan Kehadiran ${dateFrom} s/d ${dateTo}`);
        await cleanupExcelFile(filePath);
        logger.info({ event: 'bot_excel_sent', from: message.from, period: `${dateFrom}/${dateTo}` }, 'Excel report sent');
        return;
      }

      const response = formatReport(report, parsed);
      await reply(response);

      await sendButtons(
        'Pilih aksi:',
        [
          { id: 'export_excel', body: 'Download Excel' },
          { id: 'refresh', body: 'Refresh Data' },
          { id: 'help', body: 'Lihat Menu' },
        ],
        undefined,
        'Bot Absensi',
      );

      logger.info({ event: 'bot_response_sent', from: message.from, period: `${dateFrom}/${dateTo}` }, 'Bot response sent');
    } catch (error) {
      logger.error({ err: error, event: 'bot_handler_error' }, 'Bot handler failed');
      await reply('⚠️ Terjadi kesalahan. Silakan coba lagi nanti.');
    }
  };
};
