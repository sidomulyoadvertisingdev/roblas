import type { ParsedIntent } from './groq-client.js';
import type { AttendanceReport, AttendanceRow } from './attendance-client.js';

export const HELP_TEXT = `*BOT ABSENSI — Panduan*

*Laporan Kehadiran*
> laporan kehadiran bulan ini
> absen saya bulan lalu
> rekap kehadiran tanggal 1 sampai 15 Juli
> siapa yang ga masuk hari ini

*Cari Karyawan*
> absen Tahuri bulan Juni
> rekap kehadiran Leo Amanda
> gaji Akhmad bulan ini

*Laporan Khusus*
> siapa yang terlambat hari ini
> yang alpha siapa
> siapa yang cuti bulan lalu

*Export Excel*
> download excel
> unduh laporan excel

*Format Tanggal*
hari ini | kemarin | minggu ini | bulan ini | bulan lalu
tanggal 1 sampai 15 Juli | dari 1 Juni sampai 30 Juni

Ketik pesan dalam bahasa alami, bot akan memahami maksud Anda.`;

const formatCurrency = (amount: number): string => {
  return `Rp ${Math.round(amount).toLocaleString('id-ID')}`;
};

const formatDate = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
};

const pct = (part: number, total: number): string => {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
};

const bar = (part: number, total: number, len = 10): string => {
  if (total === 0) return '░'.repeat(len);
  const filled = Math.round((part / total) * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
};

const formatSingleEmployee = (row: AttendanceRow, period: { dateFrom: string; dateTo: string }): string => {
  const lines: string[] = [];
  const hadirPct = pct(row.present, row.workingDays);

  lines.push(`*LAPORAN KEHADIRAN*`);
  lines.push(`_${row.employeeName}_`);
  lines.push(`${row.positionName} — ${row.outletName}`);
  lines.push('');

  lines.push(`Periode : ${formatDate(period.dateFrom)} — ${formatDate(period.dateTo)}`);
  lines.push(`Hadir   : ${row.present}/${row.workingDays} hari (${hadirPct})`);
  lines.push(`${bar(row.present, row.workingDays)} ${hadirPct}`);

  if (row.leave > 0) lines.push(`Izin    : ${row.leave} hari`);
  if (row.sick > 0) lines.push(`Sakit   : ${row.sick} hari`);
  if (row.absent > 0) lines.push(`Alpha   : ${row.absent} hari`);
  if (row.lateCount > 0) lines.push(`Terlambat : ${row.lateCount} kali`);

  if (row.overtimeMinutes > 0) {
    const hours = Math.floor(row.overtimeMinutes / 60);
    const mins = row.overtimeMinutes % 60;
    const lemburStr = hours > 0 ? `${hours}j ${mins}m` : `${mins} menit`;
    lines.push(`Lembur  : ${lemburStr}`);
  }

  if (row.payrollAmount > 0) {
    lines.push('');
    lines.push(`*Gaji : ${formatCurrency(row.payrollAmount)}*`);
  }

  lines.push('');
  if (row.present === row.workingDays) {
    lines.push(`> Hadir sempurna. Tidak ada catatan negatif.`);
  } else if (row.absent >= row.workingDays * 0.5) {
    lines.push(`> Perhatian: alpha ${row.absent} dari ${row.workingDays} hari kerja.`);
  }

  lines.push('');
  lines.push('__________________________');
  lines.push('Ketik *download excel* untuk unduh file Excel.');

  return lines.join('\n');
};

const formatMultiEmployee = (rows: AttendanceRow[], period: { dateFrom: string; dateTo: string }): string => {
  const lines: string[] = [];

  const totalDays = rows.reduce((s, r) => s + r.workingDays, 0);
  const totalPresent = rows.reduce((s, r) => s + r.present, 0);
  const totalAbsent = rows.reduce((s, r) => s + r.absent, 0);
  const totalLate = rows.reduce((s, r) => s + r.lateCount, 0);
  const totalPayroll = rows.reduce((s, r) => s + r.payrollAmount, 0);
  const totalOvertime = rows.reduce((s, r) => s + r.overtimeMinutes, 0);

  lines.push(`*LAPORAN KEHADIRAN*`);
  lines.push(`Periode : ${formatDate(period.dateFrom)} — ${formatDate(period.dateTo)}`);
  lines.push(`Karyawan: ${rows.length} orang`);
  lines.push('');

  lines.push(`Hadir   : ${totalPresent}/${totalDays} hari (${pct(totalPresent, totalDays)})`);
  lines.push(`${bar(totalPresent, totalDays)} ${pct(totalPresent, totalDays)}`);
  if (totalAbsent > 0) lines.push(`Alpha   : ${totalAbsent} hari`);
  if (totalLate > 0) lines.push(`Terlambat : ${totalLate} kali`);
  if (totalOvertime > 0) {
    const h = Math.floor(totalOvertime / 60);
    const m = totalOvertime % 60;
    lines.push(`Lembur  : ${h > 0 ? `${h}j ${m}m` : `${m} menit`}`);
  }
  lines.push(`Total Gaji : ${formatCurrency(totalPayroll)}`);
  lines.push('');

  lines.push('__________________________');
  lines.push('');

  rows
    .sort((a, b) => b.present - a.present)
    .forEach((row, i) => {
      const hp = pct(row.present, row.workingDays);
      const flags: string[] = [];
      if (row.absent > 0) flags.push(`❌${row.absent}`);
      if (row.lateCount > 0) flags.push(`⏰${row.lateCount}`);
      if (row.leave > 0) flags.push(`📝${row.leave}`);
      if (row.sick > 0) flags.push(`🏥${row.sick}`);
      const flagStr = flags.length > 0 ? ' ' + flags.join(' ') : '';

      lines.push(`${i + 1}. *${row.employeeName}* — ${row.present}/${row.workingDays} (${hp})${flagStr}`);
    });

  lines.push('');
  lines.push('__________________________');
  lines.push('Ketik *download excel* untuk unduh file Excel.');

  return lines.join('\n');
};

export const formatReport = (report: AttendanceReport, parsed: ParsedIntent): string => {
  let rows = report.rows;

  if (parsed.employeeName) {
    const searchName = parsed.employeeName.toLowerCase();
    rows = rows.filter((r) => r.employeeName.toLowerCase().includes(searchName));
  }

  if (parsed.department) {
    const searchDept = parsed.department.toLowerCase();
    rows = rows.filter((r) => r.outletName.toLowerCase().includes(searchDept) || r.positionName.toLowerCase().includes(searchDept));
  }

  if (rows.length === 0) {
    return 'Tidak ada data yang sesuai dengan pencarian.';
  }

  if (rows.length === 1 && rows[0]) {
    return formatSingleEmployee(rows[0], report.period);
  }

  return formatMultiEmployee(rows, report.period);
};
