import type { Logger } from '../logger.js';

export interface ParsedIntent {
  intent: 'attendance_report' | 'export_excel' | 'help' | 'unknown';
  dateFrom: string | null;
  dateTo: string | null;
  department: string | null;
  employeeName: string | null;
  period: 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month' | 'custom' | null;
}

const MONTH_MAP: Record<string, number> = {
  januari: 0, jan: 0, februari: 1, feb: 1, maret: 2, mar: 2,
  april: 3, apr: 3, mei: 4, juni: 5, jun: 5, juli: 6, jul: 6,
  agustus: 7, ags: 7, september: 8, sep: 8, oktober: 9, okt: 9,
  november: 10, nov: 10, desember: 11, des: 11,
};

const parseIndonesianDate = (dayStr: string, monthStr: string, yearStr?: string): string | null => {
  const day = parseInt(dayStr, 10);
  const month = MONTH_MAP[monthStr.toLowerCase()];
  if (month === undefined || isNaN(day)) return null;
  const now = new Date();
  let year = yearStr ? parseInt(yearStr, 10) : now.getFullYear();
  if (year < 100) year += 2000;
  // Use YYYY-MM-DD format directly to avoid timezone issues
  const m = String(month + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
};

const extractDates = (message: string): { dateFrom: string | null; dateTo: string | null } => {
  const lower = message.toLowerCase();

  // "dari tanggal 1 juni sampai 30 juni 2026" or "tanggal 1 juni - 30 juni"
  const rangePattern = /(?:dari\s+)?tanggal\s+(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?\s*(?:sd|s\/d|sampai|hingga|-)\s*(?:tanggal\s+)?(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?/i;
  const rangeMatch = lower.match(rangePattern);
  if (rangeMatch) {
    const [, d1, m1, y1, d2, m2, y2] = rangeMatch;
    const from = parseIndonesianDate(d1!, m1!, y1);
    const to = parseIndonesianDate(d2!, m2!, y2);
    if (from && to) return { dateFrom: from, dateTo: to };
  }

  // "dari 1 juni sampai 30 juni" or "1 juni - 30 juni" (no "tanggal")
  const rangePattern2 = /(?:dari\s+)?(\d{1,2})\s+(\w+)\s*(?:sd|s\/d|sampai|hingga|-)\s*(?:tanggal\s+)?(\d{1,2})\s+(\w+)/i;
  const rangeMatch2 = lower.match(rangePattern2);
  if (rangeMatch2) {
    const [, d1, m1, d2, m2] = rangeMatch2;
    const from = parseIndonesianDate(d1!, m1!);
    const to = parseIndonesianDate(d2!, m2!);
    if (from && to) return { dateFrom: from, dateTo: to };
  }

  return { dateFrom: null, dateTo: null };
};

const extractEmployeeName = (message: string): string | null => {
  // "laporan absen/rekap/kehadiran/hadir/alpha/izin [name] ..."
  // "absen/rekap/terlambat/sakit/cuti [name]"
  const pattern = /(?:laporan\s+)?(?:absen|rekap|kehadiran|hadir|alpha|izin|terlambat|telat|sakit|cuti|gaji|lembur)\s+(\w[\w\s]*?)(?:\s+(?:dari|tanggal|bulan|untuk|yang|sd|s\/d|sampai)|$)/i;
  const match = message.match(pattern);
  if (!match?.[1]) return null;

  let name = match[1].trim();
  const stopWords = [
    'dari', 'tanggal', 'bulan', 'ini', 'lalu', 'hari', 'kemarin', 'minggu', 'sampai',
    'sd', 's/d', 'untuk', 'yang', 'di', 'ke', 'kehadiran', 'hadir',
    // question words
    'siapa', 'apa', 'berapa', 'dimana', 'kapan', 'bagaimana', 'mengapa',
    // month names
    'januari', 'jan', 'februari', 'feb', 'maret', 'mar', 'april', 'apr',
    'mei', 'juni', 'jun', 'juli', 'jul', 'agustus', 'ags',
    'september', 'sep', 'oktober', 'okt', 'november', 'nov', 'desember', 'des',
  ];
  const words = name.split(/\s+/).filter((w) => !stopWords.includes(w.toLowerCase()));
  name = words.join(' ').trim();
  if (name.length >= 2 && name.length <= 40 && /[a-zA-Z]/.test(name)) {
    return name;
  }
  return null;
};

const SYSTEM_PROMPT = `Kamu adalah parser NLU untuk sistem absensi HRD karyawan. Return HANYA JSON valid.

Schema:
{
  "intent": "attendance_report" | "export_excel" | "help" | "unknown",
  "dateFrom": "YYYY-MM-DD" | null,
  "dateTo": "YYYY-MM-DD" | null,
  "department": string | null,
  "employeeName": string | null,
  "period": "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "custom" | null
}

Kosa kata absensi Indonesia:
- "absen" / "rekap" / "kehadiran" / "laporan hadir" → attendance_report
- "tidak masuk" / "ga masuk" / "alpha" / "bolos" → absent (bagian dari attendance_report)
- "terlambat" / "telat" / "delay" → late
- "lembur" / "overtime" / "OT" → overtime
- "cuti" / "leave" → leave
- "sakit" → sick
- "izin" / "permit" → permission
- "gaji" / "upah" / "salary" → payroll (bagian dari attendance_report)
- "unduh" / "download" / "kirim file" / "export" / "excel" / "xlsx" / "file" → export_excel
- "bantuan" / "menu" / "command" / "help" / "fitur" → help

Aturan periode:
- Hari ini: {TODAY}
- "hari ini" → period: "today"
- "kemarin" / "yesterday" → period: "yesterday"
- "minggu ini" / "seminggu ini" → period: "this_week"
- "bulan ini" → period: "this_month"
- "bulan lalu" / "bulan kemarin" → period: "last_month"
- "tanggal X sampai Y" / "dari X sampai Y" / "X - Y" → period: null, dateFrom/dateTo diisi
- Jika tidak ada periode → period: "this_month"

Aturan nama:
- Jika ada nama karyawan disebut → employeeName diisi PERSIS seperti yang disebut (case-sensitive)
- Jika ada departemen/outlet → department diisi
- Jika tidak ada nama → employeeName: null

Intent:
- Default untuk pertanyaan absensi → "attendance_report"
- "unknown" jika tidak paham`;

export const parseMessage = async (
  message: string,
  apiKey: string,
  model: string,
  logger: Logger,
): Promise<ParsedIntent> => {
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = SYSTEM_PROMPT.replace('{TODAY}', today);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error({ event: 'groq_api_error', status: response.status, body: text.slice(0, 200) }, 'Groq API request failed');
    return { intent: 'unknown', dateFrom: null, dateTo: null, department: null, employeeName: null, period: null };
  }

  const body = await response.json() as { choices: Array<{ message: { content: string } }> };
  const content = body.choices?.[0]?.message?.content ?? '';
  logger.info({ event: 'groq_raw_response', content }, 'Groq raw response');

  let groqResult: ParsedIntent;
  try {
    const parsed = JSON.parse(content) as ParsedIntent;
    groqResult = {
      intent: parsed.intent ?? 'unknown',
      dateFrom: parsed.dateFrom ?? null,
      dateTo: parsed.dateTo ?? null,
      department: parsed.department ?? null,
      employeeName: parsed.employeeName ?? null,
      period: parsed.period ?? null,
    };
  } catch {
    logger.warn({ event: 'groq_parse_failed', content }, 'Failed to parse Groq response as JSON');
    groqResult = { intent: 'unknown', dateFrom: null, dateTo: null, department: null, employeeName: null, period: null };
  }

  // Regex overrides — more reliable than LLM for structured extraction
  const regexDates = extractDates(message);
  const regexName = extractEmployeeName(message);

  const result: ParsedIntent = {
    ...groqResult,
    dateFrom: regexDates.dateFrom ?? groqResult.dateFrom,
    dateTo: regexDates.dateTo ?? groqResult.dateTo,
    employeeName: regexName ?? groqResult.employeeName,
  };

  if (regexDates.dateFrom || regexName) {
    logger.info({ event: 'regex_override', regexDates, regexName, groqEmployeeName: groqResult.employeeName }, 'Regex extraction applied');
  }

  return result;
};
