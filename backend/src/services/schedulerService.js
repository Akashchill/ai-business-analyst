import cron from 'node-cron';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import { getReport } from './reportService.js';

const schedules = new Map(); // id → { task, meta }

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function rowsToCSV(rows) {
  if (!rows?.length) return 'No data';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map(r => headers.map(h => {
      const v = String(r[h] ?? '').replace(/"/g, '""');
      return v.includes(',') || v.includes('"') ? `"${v}"` : v;
    }).join(',')),
  ].join('\n');
}

function rowsToHTML(rows, report) {
  if (!rows?.length) return '<p>No data available.</p>';
  const headers = Object.keys(rows[0]);
  const headerRow = headers.map(h => `<th style="background:#1e293b;color:#94a3b8;padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase">${h}</th>`).join('');
  const dataRows = rows.slice(0, 100).map(r =>
    `<tr>${headers.map(h => `<td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-size:13px">${r[h] ?? ''}</td>`).join('')}</tr>`
  ).join('');

  return `
<!DOCTYPE html>
<html>
<body style="font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px">
  <h2 style="color:#6366f1">${report.name}</h2>
  ${report.insight?.summary ? `<p style="color:#94a3b8;background:#1e293b;padding:12px;border-radius:8px">${report.insight.summary}</p>` : ''}
  <p style="color:#475569;font-size:12px">${rows.length} rows · Generated ${new Date().toLocaleString()}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    <thead><tr>${headerRow}</tr></thead>
    <tbody>${dataRows}</tbody>
  </table>
  ${rows.length > 100 ? `<p style="color:#475569;font-size:12px">Showing first 100 of ${rows.length} rows. Download the CSV for full data.</p>` : ''}
</body>
</html>`;
}

export function scheduleReport({ reportId, cron: cronExpr, emails, format, userId }) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron expression: ${cronExpr}`);

  const id = uuidv4();
  const meta = {
    id, reportId, cron: cronExpr, emails, format, userId,
    createdAt: new Date().toISOString(),
    lastRun: null, runCount: 0, nextRun: null,
  };

  const task = cron.schedule(cronExpr, async () => {
    meta.lastRun = new Date().toISOString();
    meta.runCount++;

    const report = getReport(reportId);
    if (!report) { console.warn(`Scheduled report ${reportId} not found`); return; }

    try {
      const transporter = createTransporter();
      const csv = rowsToCSV(report.rows);
      const html = rowsToHTML(report.rows, report);

      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'analytics@company.com',
        to: emails.join(', '),
        subject: `📊 Scheduled Report: ${report.name}`,
        html,
        attachments: format === 'csv' ? [{ filename: `${report.name}.csv`, content: csv }] : [],
      });

      console.log(`📧 Sent report "${report.name}" to ${emails.join(', ')}`);
    } catch (err) {
      console.error('Email send failed:', err.message);
    }
  });

  schedules.set(id, { task, meta });
  console.log(`⏰ Scheduled report "${reportId}" with cron: ${cronExpr}`);
  return meta;
}

export function listSchedules(userId) {
  return [...schedules.values()]
    .filter(s => !userId || s.meta.userId === userId)
    .map(s => s.meta);
}

export function cancelSchedule(id) {
  const entry = schedules.get(id);
  if (!entry) return false;
  entry.task.stop();
  schedules.delete(id);
  return true;
}

export function getScheduleStats() {
  return { count: schedules.size };
}
