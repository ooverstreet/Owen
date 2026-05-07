'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
});

process.on('beforeExit', (code) => {
  console.warn(`Process beforeExit with code ${code}`);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const REPORT_PHOTOS_BUCKET = process.env.REPORT_PHOTOS_BUCKET || 'report-photos';

let supabase = null;
let supabaseInitError = null;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  supabaseInitError = 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing';
  console.warn(`${supabaseInitError}. API calls will fail until set.`);
} else {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (e) {
    supabaseInitError = e?.message || 'Supabase client failed to initialize';
    console.error('Supabase initialization error:', e);
  }
}

const issueTypeEnum = z.enum([
  'accident',
  'pothole',
  'signal_out',
  'debris',
  'flooding',
  'roadwork',
  'congestion',
  'other',
]);
const issueSeverityEnum = z.enum(['low', 'medium', 'high']);
const reportStatusEnum = z.enum(['resolved', 'hidden', 'rejected', 'expired']);

const createReportSchema = z.object({
  issueType: issueTypeEnum,
  severity: issueSeverityEnum,
  description: z.string().min(8).max(500),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  locationText: z.string().max(200).optional().nullable(),
  isAnonymous: z.boolean().optional().default(false),
  photoUrl: z.string().url().optional().nullable(),
});

const signedUrlSchema = z.object({
  contentType: z.string().min(3).max(120),
  extension: z.enum(['jpg', 'jpeg', 'png', 'webp']),
});

function parseBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim();
}

function toPublicReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    issueType: row.issue_type,
    severity: row.severity,
    description: row.description,
    photoUrl: row.photo_url || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    locationText: row.location_text || null,
    latitude: row.latitude,
    longitude: row.longitude,
    reporterLabel: row.reporter_label,
    confirmCount: row.confirm_count || 0,
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function toApiError(res, status, message, details) {
  return res.status(status).json({
    error: message,
    details: details || null,
  });
}

function ensureSupabase(res) {
  if (supabase) return true;
  toApiError(res, 503, 'Supabase is not configured', supabaseInitError || 'Missing configuration');
  return false;
}

async function requireUser(req, res, next) {
  if (!ensureSupabase(res)) return;
  const token = parseBearerToken(req);
  if (!token) return toApiError(res, 401, 'Missing bearer token');
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return toApiError(res, 401, 'Invalid or expired auth token');
  req.user = data.user;
  next();
}

async function requireModerator(req, res, next) {
  const { data, error } = await supabase
    .from('profiles')
    .select('is_moderator')
    .eq('id', req.user.id)
    .maybeSingle();

  if (error) return toApiError(res, 500, 'Failed to verify moderator role', error.message);
  if (!data?.is_moderator) return toApiError(res, 403, 'Moderator role required');
  next();
}

app.get('/', (_req, res) => {
  res.json({ service: 'Tellit API', ok: true });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    supabaseConfigured: Boolean(supabase),
    ...(supabase ? {} : { supabaseError: supabaseInitError }),
  });
});

app.get('/v1/reports', async (req, res) => {
  if (!ensureSupabase(res)) return;
  const lat = req.query.lat !== undefined ? Number(req.query.lat) : null;
  const lng = req.query.lng !== undefined ? Number(req.query.lng) : null;
  const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : 8;
  const sinceHours = req.query.sinceHours !== undefined ? Number(req.query.sinceHours) : 24;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 50;
  const issueType = req.query.issueType ? String(req.query.issueType) : null;
  const severity = req.query.severity ? String(req.query.severity) : null;

  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
  const safeSinceHours = Number.isFinite(sinceHours) ? Math.min(Math.max(sinceHours, 1), 168) : 24;

  let query = supabase
    .from('report_feed')
    .select('*')
    .gte('created_at', new Date(Date.now() - safeSinceHours * 3600 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(300);

  if (issueType) query = query.eq('issue_type', issueType);
  if (severity) query = query.eq('severity', severity);

  const { data, error } = await query;
  if (error) return toApiError(res, 500, 'Failed to load reports', error.message);

  let rows = data || [];
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Number.isFinite(radiusKm) &&
    radiusKm >= 0.2 &&
    radiusKm <= 50
  ) {
    rows = rows.filter((r) => haversineKm(lat, lng, Number(r.latitude), Number(r.longitude)) <= radiusKm);
  }

  rows = rows.slice(0, safeLimit);
  res.json({
    data: rows.map(toPublicReport),
    meta: { count: rows.length },
  });
});

app.get('/v1/reports/:reportId', async (req, res) => {
  if (!ensureSupabase(res)) return;
  const reportId = Number(req.params.reportId);
  if (!Number.isInteger(reportId) || reportId <= 0) return toApiError(res, 400, 'Invalid reportId');

  const { data, error } = await supabase
    .from('report_feed')
    .select('*')
    .eq('id', reportId)
    .maybeSingle();
  if (error) return toApiError(res, 500, 'Failed to load report', error.message);
  if (!data) return toApiError(res, 404, 'Report not found');

  res.json({ data: toPublicReport(data) });
});

app.post('/v1/reports', requireUser, async (req, res) => {
  const parsed = createReportSchema.safeParse(req.body || {});
  if (!parsed.success) return toApiError(res, 400, 'Validation failed', parsed.error.flatten());
  const input = parsed.data;

  const locationWkt = `POINT(${input.longitude} ${input.latitude})`;
  const payload = {
    user_id: req.user.id,
    is_anonymous: input.isAnonymous,
    issue_type: input.issueType,
    severity: input.severity,
    description: input.description,
    location: locationWkt,
    location_text: input.locationText || null,
    photo_url: input.photoUrl || null,
  };

  const { data, error } = await supabase
    .from('reports')
    .insert(payload)
    .select(
      'id, issue_type, severity, description, photo_url, status, created_at, updated_at, expires_at, location_text'
    )
    .single();
  if (error) return toApiError(res, 500, 'Failed to create report', error.message);

  res.status(201).json({
    data: {
      id: data.id,
      issueType: data.issue_type,
      severity: data.severity,
      description: data.description,
      photoUrl: data.photo_url || null,
      status: data.status,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      expiresAt: data.expires_at,
      locationText: data.location_text || null,
    },
  });
});

app.post('/v1/reports/:reportId/confirm', requireUser, async (req, res) => {
  const reportId = Number(req.params.reportId);
  if (!Number.isInteger(reportId) || reportId <= 0) return toApiError(res, 400, 'Invalid reportId');

  const { error } = await supabase
    .from('report_confirmations')
    .upsert(
      { report_id: reportId, user_id: req.user.id },
      { onConflict: 'report_id,user_id', ignoreDuplicates: true }
    );
  if (error) return toApiError(res, 500, 'Failed to confirm report', error.message);

  const { count, error: countError } = await supabase
    .from('report_confirmations')
    .select('*', { count: 'exact', head: true })
    .eq('report_id', reportId);
  if (countError) return toApiError(res, 500, 'Failed to count confirmations', countError.message);

  res.json({ confirmed: true, confirmCount: count || 0 });
});

app.delete('/v1/reports/:reportId/confirm', requireUser, async (req, res) => {
  const reportId = Number(req.params.reportId);
  if (!Number.isInteger(reportId) || reportId <= 0) return toApiError(res, 400, 'Invalid reportId');

  const { error } = await supabase
    .from('report_confirmations')
    .delete()
    .eq('report_id', reportId)
    .eq('user_id', req.user.id);
  if (error) return toApiError(res, 500, 'Failed to remove confirmation', error.message);

  const { count, error: countError } = await supabase
    .from('report_confirmations')
    .select('*', { count: 'exact', head: true })
    .eq('report_id', reportId);
  if (countError) return toApiError(res, 500, 'Failed to count confirmations', countError.message);

  res.json({ confirmed: false, confirmCount: count || 0 });
});

app.post('/v1/reports/:reportId/resolve', requireUser, requireModerator, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const reportId = Number(req.params.reportId);
  if (!Number.isInteger(reportId) || reportId <= 0) return toApiError(res, 400, 'Invalid reportId');
  const schema = z.object({
    toStatus: reportStatusEnum,
    note: z.string().max(500).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return toApiError(res, 400, 'Validation failed', parsed.error.flatten());

  const { toStatus, note } = parsed.data;
  const { data: before, error: beforeError } = await supabase
    .from('reports')
    .select('status')
    .eq('id', reportId)
    .maybeSingle();
  if (beforeError) return toApiError(res, 500, 'Failed to load report', beforeError.message);
  if (!before) return toApiError(res, 404, 'Report not found');

  const updatePayload = {
    status: toStatus,
    resolved_at: ['resolved', 'expired'].includes(toStatus) ? new Date().toISOString() : null,
    resolved_by: req.user.id,
    resolution_note: note || null,
  };
  const { error: updateError } = await supabase.from('reports').update(updatePayload).eq('id', reportId);
  if (updateError) return toApiError(res, 500, 'Failed to update report status', updateError.message);

  const { error: eventError } = await supabase.from('report_status_events').insert({
    report_id: reportId,
    actor_user_id: req.user.id,
    from_status: before.status,
    to_status: toStatus,
    note: note || null,
  });
  if (eventError) return toApiError(res, 500, 'Failed to write status event', eventError.message);

  res.json({ ok: true, reportId, fromStatus: before.status, toStatus });
});

app.post('/v1/uploads/report-photo-url', requireUser, async (req, res) => {
  const parsed = signedUrlSchema.safeParse(req.body || {});
  if (!parsed.success) return toApiError(res, 400, 'Validation failed', parsed.error.flatten());
  const { extension } = parsed.data;

  const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const objectPath = `${req.user.id}/${filename}`;

  const { data, error } = await supabase.storage.from(REPORT_PHOTOS_BUCKET).createSignedUploadUrl(objectPath);
  if (error) return toApiError(res, 500, 'Failed to create signed upload URL', error.message);

  const {
    data: { publicUrl },
  } = supabase.storage.from(REPORT_PHOTOS_BUCKET).getPublicUrl(objectPath);

  res.json({
    uploadUrl: data.signedUrl,
    token: data.token,
    path: objectPath,
    publicUrl,
  });
});

app.get('/v1/me/reports', requireUser, async (req, res) => {
  const { data, error } = await supabase
    .from('reports')
    .select(
      'id, issue_type, severity, description, photo_url, status, created_at, updated_at, expires_at, resolved_at, resolution_note, location_text, is_anonymous'
    )
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return toApiError(res, 500, 'Failed to load my reports', error.message);

  res.json({
    data: (data || []).map((r) => ({
      id: r.id,
      issueType: r.issue_type,
      severity: r.severity,
      description: r.description,
      photoUrl: r.photo_url || null,
      status: r.status,
      locationText: r.location_text || null,
      isAnonymous: r.is_anonymous,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
      resolvedAt: r.resolved_at,
      resolutionNote: r.resolution_note || null,
    })),
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  toApiError(res, 500, 'Internal server error');
});

app.listen(PORT, HOST, () => {
  console.log(`Tellit API boot timestamp: ${new Date().toISOString()}`);
  console.log(`Tellit API listening on ${HOST}:${PORT}`);
  console.log(`Supabase configured: ${Boolean(supabase)}`);
  console.log(`SUPABASE_URL present: ${Boolean(SUPABASE_URL)}`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY present: ${Boolean(SUPABASE_SERVICE_ROLE_KEY)}`);
});
