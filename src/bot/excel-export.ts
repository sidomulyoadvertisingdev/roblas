import ExcelJS from 'exceljs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttendanceReport } from './attendance-client.js';

export const generateAttendanceExcel = async (
  report: AttendanceReport,
  dateFrom: string,
  dateTo: string,
): Promise<string> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Rorojongrang Bot';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Laporan Kehadiran');

  sheet.columns = [
    { header: 'No', key: 'no', width: 6 },
    { header: 'Nama Karyawan', key: 'employeeName', width: 25 },
    { header: 'NIK', key: 'employeeId', width: 12 },
    { header: 'Outlet', key: 'outletName', width: 20 },
    { header: 'Posisi', key: 'positionName', width: 18 },
    { header: 'H Kerja', key: 'workingDays', width: 10 },
    { header: 'Hadir', key: 'present', width: 10 },
    { header: 'Izin', key: 'leave', width: 10 },
    { header: 'Sakit', key: 'sick', width: 10 },
    { header: 'Alpha', key: 'absent', width: 10 },
    { header: 'Terlambat', key: 'lateCount', width: 12 },
    { header: 'Lembur (jam)', key: 'overtimeMinutes', width: 14 },
    { header: 'Gaji', key: 'payrollAmount', width: 18 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
  headerRow.alignment = { horizontal: 'center' };

  report.rows.forEach((row, idx) => {
    const r = sheet.addRow({
      no: idx + 1,
      employeeName: row.employeeName,
      employeeId: row.employeeId,
      outletName: row.outletName,
      positionName: row.positionName,
      workingDays: row.workingDays,
      present: row.present,
      leave: row.leave,
      sick: row.sick,
      absent: row.absent,
      lateCount: row.lateCount,
      overtimeMinutes: row.overtimeMinutes,
      payrollAmount: row.payrollAmount,
    });
    r.alignment = { horizontal: 'center' };
    r.getCell('employeeName').alignment = { horizontal: 'left' };
    r.getCell('outletName').alignment = { horizontal: 'left' };
    r.getCell('positionName').alignment = { horizontal: 'left' };
    r.getCell('payrollAmount').numFmt = '#,##0';
  });

  const summarySheet = workbook.addWorksheet('Ringkasan');
  summarySheet.columns = [
    { header: 'Metrik', key: 'metric', width: 25 },
    { header: 'Nilai', key: 'value', width: 20 },
  ];

  const sHeader = summarySheet.getRow(1);
  sHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };

  summarySheet.addRow({ metric: 'Periode', value: `${dateFrom} s/d ${dateTo}` });
  summarySheet.addRow({ metric: 'Jumlah Karyawan', value: report.summary.employeeCount });
  summarySheet.addRow({ metric: 'Total Hadir', value: report.summary.presentTotal });
  summarySheet.addRow({ metric: 'Total Alpha', value: report.summary.absentTotal });
  summarySheet.addRow({ metric: 'Total Terlambat', value: report.summary.lateTotal });
  summarySheet.addRow({ metric: 'Total Lembur (jam)', value: report.summary.overtimeMinutesTotal });
  summarySheet.addRow({ metric: 'Total Gaji', value: report.summary.payrollTotal });

  const tmpDir = await mkdtemp(join(tmpdir(), 'bot-excel-'));
  const filePath = join(tmpDir, `laporan-kehadiran-${dateFrom}-sd-${dateTo}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
};

export const cleanupExcelFile = async (filePath: string): Promise<void> => {
  try {
    const dir = join(filePath, '..');
    await rm(filePath);
    await rm(dir);
  } catch {
    // ignore cleanup errors
  }
};
