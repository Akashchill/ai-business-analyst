import express from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { saveReport, listReports, getReport, updateReport, deleteReport } from '../services/reportService.js';
import { scheduleReport, listSchedules, cancelSchedule } from '../services/schedulerService.js';

const router = express.Router();

// POST /api/reports — save a report
router.post('/', authenticate, async (req, res) => {
  const { name, description, question, result, isPublic } = req.body;
  if (!name || !result) return res.status(400).json({ error: 'name and result required' });
  try {
    const report = saveReport({ name, description, question, result, createdBy: req.user.id, isPublic });
    res.status(201).json({ report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports
router.get('/', authenticate, (req, res) => {
  const reports = listReports(req.user.id, req.user.role);
  res.json({ reports });
});

// GET /api/reports/:id
router.get('/:id', authenticate, (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (!report.isPublic && report.createdBy !== req.user.id && req.user.role === 'analyst') {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json({ report });
});

// PUT /api/reports/:id
router.put('/:id', authenticate, (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.createdBy !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your report' });
  }
  const updated = updateReport(req.params.id, req.body);
  res.json({ report: updated });
});

// DELETE /api/reports/:id
router.delete('/:id', authenticate, (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.createdBy !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your report' });
  }
  deleteReport(req.params.id);
  res.json({ success: true });
});

// POST /api/reports/:id/schedule
router.post('/:id/schedule', authenticate, requirePermission('canScheduleReports'), async (req, res) => {
  const { cron, emails, format = 'csv' } = req.body;
  if (!cron || !emails?.length) return res.status(400).json({ error: 'cron and emails required' });

  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  try {
    const schedule = scheduleReport({ reportId: req.params.id, cron, emails, format, userId: req.user.id });
    res.json({ schedule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/reports/schedules/list
router.get('/schedules/list', authenticate, requirePermission('canScheduleReports'), (req, res) => {
  res.json({ schedules: listSchedules(req.user.id) });
});

// DELETE /api/reports/schedules/:id
router.delete('/schedules/:id', authenticate, requirePermission('canScheduleReports'), (req, res) => {
  const ok = cancelSchedule(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ success: true });
});

export default router;
