import type { Logger } from '../logger.js';

interface AttendancePeriod {
  dateFrom: string;
  dateTo: string;
}

export interface AttendanceSummary {
  employeeCount: number;
  presentTotal: number;
  absentTotal: number;
  lateTotal: number;
  overtimeMinutesTotal: number;
  payrollTotal: number;
}

export interface AttendanceRow {
  employeeId: number;
  employeeName: string;
  outletName: string;
  positionName: string;
  workingDays: number;
  present: number;
  leave: number;
  sick: number;
  absent: number;
  lateCount: number;
  overtimeMinutes: number;
  payrollAmount: number;
}

export interface AttendanceReport {
  period: AttendancePeriod;
  summary: AttendanceSummary;
  rows: AttendanceRow[];
}

export const fetchReport = async (
  apiUrl: string,
  bearerToken: string,
  dateFrom: string,
  dateTo: string,
  logger: Logger,
): Promise<AttendanceReport | null> => {
  const url = new URL(apiUrl);
  url.searchParams.set('date_from', dateFrom);
  url.searchParams.set('date_to', dateTo);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'authorization': `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error({ event: 'attendance_api_error', status: response.status }, 'Attendance API request failed');
      return null;
    }

    const body = await response.json() as { data: { period: { date_from: string; date_to: string }; summary: Record<string, number>; rows: Array<Record<string, unknown>> } };

    if (!body.data) return null;

    return {
      period: {
        dateFrom: body.data.period.date_from,
        dateTo: body.data.period.date_to,
      },
      summary: {
        employeeCount: (body.data.summary.employee_count as number) ?? 0,
        presentTotal: (body.data.summary.present_total as number) ?? 0,
        absentTotal: (body.data.summary.absent_total as number) ?? 0,
        lateTotal: (body.data.summary.late_total as number) ?? 0,
        overtimeMinutesTotal: (body.data.summary.overtime_minutes_total as number) ?? 0,
        payrollTotal: (body.data.summary.payroll_total as number) ?? 0,
      },
      rows: body.data.rows.map((row) => ({
        employeeId: row.employee_id as number,
        employeeName: row.employee_name as string,
        outletName: row.outlet_name as string,
        positionName: row.position_name as string,
        workingDays: row.working_days as number,
        present: row.present as number,
        leave: row.leave as number,
        sick: row.sick as number,
        absent: row.absent as number,
        lateCount: row.late_count as number,
        overtimeMinutes: row.overtime_minutes as number,
        payrollAmount: row.payroll_amount as number,
      })),
    };
  } catch (error) {
    logger.error({ err: error, event: 'attendance_api_fetch_failed' }, 'Failed to fetch attendance report');
    return null;
  }
};
