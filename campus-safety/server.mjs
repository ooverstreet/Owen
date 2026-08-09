#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadDb, saveDb, audit, resetDb, uid, now } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const PUBLIC = __dirname;

let db = loadDb();

const ALERT_TEMPLATES = {
  lockdown: {
    title: 'LOCKDOWN in effect',
    body: 'Lincoln High School is in lockdown. Students and staff are sheltering in secure locations.',
    parentGuidance:
      'Do not come to campus. Do not call or text students. Wait for official updates here. Pickup is paused until all-clear.',
  },
  shelter_in_place: {
    title: 'Shelter-in-place',
    body: 'Campus is sheltering in place while safety teams assess the situation.',
    parentGuidance:
      'Stay clear of campus for now. Pickup may be delayed. Monitor this app for the next official update.',
  },
  avoid_area: {
    title: 'Avoid area near campus',
    body: 'Please avoid the area around campus while responders work.',
    parentGuidance:
      'Use alternate routes. Do not gather near entrances. Wait for pickup instructions before arriving.',
  },
  pickup_change: {
    title: 'Pickup / dismissal change',
    body: 'Dismissal or pickup procedures have changed for safety reasons.',
    parentGuidance: 'Follow the instructions in this alert before coming to campus. Check back for all-clear.',
  },
  info: {
    title: 'Safety update',
    body: 'School safety has issued a verified update.',
    parentGuidance: 'No immediate action required unless stated below. Continue to monitor official alerts.',
  },
  all_clear: {
    title: 'All clear',
    body: 'The situation is resolved. Normal campus operations are resuming.',
    parentGuidance: 'You may follow normal pickup and campus access procedures unless staff instruct otherwise.',
  },
};

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    ...headers,
  });
  res.end(body);
}

function notFound(res) {
  send(res, 404, { error: 'Not found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function currentUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  return db.users.find((u) => u.id === session.userId) || null;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    phone: u.phone,
    campusId: u.campusId,
    childName: u.childName,
    notifySms: u.notifySms,
    notifyPush: u.notifyPush,
    notifyEmail: u.notifyEmail,
    criticalOnly: u.criticalOnly,
  };
}

function requireUser(req, res, roles = null) {
  const user = currentUser(req);
  if (!user) {
    send(res, 401, { error: 'Sign in required' });
    return null;
  }
  if (roles && !roles.includes(user.role)) {
    send(res, 403, { error: 'Not allowed for this role' });
    return null;
  }
  return user;
}

function guessSeverity(tip) {
  const text = `${tip.category} ${tip.description} ${tip.locationText || ''}`.toLowerCase();
  const criticalWords = ['gun', 'weapon', 'knife', 'shooting', 'bleeding', 'intruder', 'bomb'];
  if (tip.happeningNow && criticalWords.some((w) => text.includes(w))) return 'critical';
  if (criticalWords.some((w) => text.includes(w))) return 'high';
  if (tip.happeningNow || tip.category === 'fight' || tip.category === 'suspicious') return 'medium';
  return 'low';
}

function campusStatusPayload() {
  const active = db.alerts
    .filter((a) => a.status === 'sent' && a.type !== 'all_clear')
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))[0];
  const latestAllClear = db.alerts
    .filter((a) => a.status === 'sent' && a.type === 'all_clear')
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))[0];

  return {
    campus: db.campus,
    activeAlert: active || null,
    latestAllClear: latestAllClear || null,
    openTipCount: db.tips.filter((t) => !['closed', 'false_alarm'].includes(t.status)).length,
  };
}

function queueDeliveries(alert, actor) {
  const audiences = new Set(alert.audience);
  const recipients = db.users.filter((u) => {
    if (u.campusId !== alert.campusId) return false;
    if (audiences.has('parents') && u.role === 'parent') return true;
    if (audiences.has('staff') && (u.role === 'staff' || u.role === 'safety_admin')) return true;
    if (audiences.has('students') && u.role === 'student_reporter') return true;
    if (audiences.has('authorities') && u.role === 'authority_liaison') return true;
    return false;
  });

  for (const user of recipients) {
    if (user.criticalOnly && !['lockdown', 'shelter_in_place', 'avoid_area'].includes(alert.type)) {
      continue;
    }
    const channels = [];
    if (alert.channels.includes('sms') && user.notifySms) channels.push('sms');
    if (alert.channels.includes('push') && user.notifyPush) channels.push('push');
    if (alert.channels.includes('email') && user.notifyEmail) channels.push('email');
    for (const channel of channels) {
      db.deliveries.unshift({
        id: uid(),
        alertId: alert.id,
        userId: user.id,
        channel,
        status: 'sent',
        preview: `[${channel.toUpperCase()}] ${alert.title}: ${alert.parentGuidance}`,
        createdAt: now(),
        deliveredAt: now(),
      });
    }
  }
  audit(db, actor.id, 'alert', alert.id, 'deliveries_queued', {
    recipients: recipients.length,
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream'
  );
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC, rel.replace(/^\/+/, ''));
  if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  res.writeHead(200, { 'Content-Type': contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    return send(res, 204, {});
  }

  // Health
  if (method === 'GET' && pathname === '/api/health') {
    return send(res, 200, { ok: true, campus: db.campus?.name });
  }

  // Demo reset
  if (method === 'POST' && pathname === '/api/demo/reset') {
    db = resetDb();
    return send(res, 200, { ok: true, message: 'Demo data reset', accounts: demoAccounts() });
  }

  if (method === 'GET' && pathname === '/api/demo/accounts') {
    return send(res, 200, { accounts: demoAccounts(), campus: db.campus });
  }

  // Auth
  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    const user = db.users.find(
      (u) => u.email.toLowerCase() === String(body.email || '').toLowerCase() && u.password === body.password
    );
    if (!user) return send(res, 401, { error: 'Invalid email or password' });
    const token = uid();
    db.sessions.push({ token, userId: user.id, createdAt: now() });
    audit(db, user.id, 'user', user.id, 'login', {});
    saveDb(db);
    return send(res, 200, { token, user: publicUser(user), campus: db.campus });
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const user = currentUser(req);
    const token = getToken(req);
    db.sessions = db.sessions.filter((s) => s.token !== token);
    if (user) audit(db, user.id, 'user', user.id, 'logout', {});
    saveDb(db);
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/me') {
    const user = requireUser(req, res);
    if (!user) return;
    return send(res, 200, { user: publicUser(user), campus: db.campus });
  }

  // Campus status (parents + all signed-in)
  if (method === 'GET' && pathname === '/api/campus/status') {
    const user = requireUser(req, res);
    if (!user) return;
    return send(res, 200, campusStatusPayload());
  }

  // Parent preferences
  if (method === 'PUT' && pathname === '/api/notification-preferences') {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    user.notifySms = !!body.notifySms;
    user.notifyPush = !!body.notifyPush;
    user.notifyEmail = !!body.notifyEmail;
    user.criticalOnly = !!body.criticalOnly;
    audit(db, user.id, 'user', user.id, 'prefs_updated', body);
    saveDb(db);
    return send(res, 200, { user: publicUser(user) });
  }

  // Tips
  if (method === 'POST' && pathname === '/api/tips') {
    const user = requireUser(req, res, ['student_reporter', 'staff', 'parent', 'safety_admin']);
    if (!user) return;
    const body = await readBody(req);
    if (!body.description || !body.category) {
      return send(res, 400, { error: 'category and description are required' });
    }
    const tip = {
      id: uid(),
      campusId: db.campus.id,
      reporterUserId: body.isAnonymous ? null : user.id,
      reporterRole: user.role,
      isAnonymous: !!body.isAnonymous,
      category: body.category,
      happeningNow: !!body.happeningNow,
      locationText: body.locationText || '',
      description: String(body.description).slice(0, 2000),
      mediaNote: body.mediaNote || '',
      status: 'new',
      createdAt: now(),
      acknowledgedAt: null,
      closedAt: null,
    };
    tip.severityGuess = guessSeverity(tip);
    if (tip.severityGuess === 'critical') tip.status = 'new';
    db.tips.unshift(tip);
    audit(db, user.id, 'tip', tip.id, 'created', {
      anonymous: tip.isAnonymous,
      severity: tip.severityGuess,
    });
    saveDb(db);
    return send(res, 201, {
      tip: sanitizeTipForReporter(tip, user),
      message: 'Tip received. Safety team notified.',
      call911: tip.happeningNow || tip.severityGuess === 'critical',
    });
  }

  if (method === 'GET' && pathname === '/api/tips/mine') {
    const user = requireUser(req, res);
    if (!user) return;
    const tips = db.tips
      .filter((t) => t.reporterUserId === user.id)
      .map((t) => sanitizeTipForReporter(t, user));
    return send(res, 200, { tips });
  }

  if (method === 'GET' && pathname === '/api/admin/tips') {
    const user = requireUser(req, res, ['safety_admin']);
    if (!user) return;
    const status = url.searchParams.get('status');
    let tips = [...db.tips];
    if (status) tips = tips.filter((t) => t.status === status);
    return send(res, 200, { tips: tips.map(enrichTip) });
  }

  const tipActionMatch = pathname.match(/^\/api\/admin\/tips\/([^/]+)\/actions$/);
  if (method === 'POST' && tipActionMatch) {
    const user = requireUser(req, res, ['safety_admin']);
    if (!user) return;
    const tip = db.tips.find((t) => t.id === tipActionMatch[1]);
    if (!tip) return send(res, 404, { error: 'Tip not found' });
    const body = await readBody(req);
    const action = body.action;
    const notes = body.notes || '';
    const allowed = ['claim', 'comment', 'monitor', 'escalate', 'dismiss', 'false_alarm', 'close'];
    if (!allowed.includes(action)) return send(res, 400, { error: 'Invalid action' });

    db.tipActions.unshift({
      id: uid(),
      tipId: tip.id,
      actorUserId: user.id,
      action,
      notes,
      createdAt: now(),
    });

    if (action === 'claim') {
      tip.status = 'in_review';
      tip.acknowledgedAt = tip.acknowledgedAt || now();
    } else if (action === 'monitor') {
      tip.status = 'monitoring';
    } else if (action === 'escalate') {
      tip.status = 'escalated';
    } else if (action === 'dismiss' || action === 'close') {
      tip.status = 'closed';
      tip.closedAt = now();
    } else if (action === 'false_alarm') {
      tip.status = 'false_alarm';
      tip.closedAt = now();
    }

    audit(db, user.id, 'tip', tip.id, action, { notes });
    saveDb(db);
    return send(res, 200, { tip: enrichTip(tip) });
  }

  // Alerts
  if (method === 'GET' && pathname === '/api/alerts/templates') {
    const user = requireUser(req, res, ['safety_admin']);
    if (!user) return;
    return send(res, 200, { templates: ALERT_TEMPLATES });
  }

  if (method === 'GET' && pathname === '/api/alerts') {
    const user = requireUser(req, res);
    if (!user) return;
    let alerts = db.alerts.filter((a) => a.status === 'sent');
    if (user.role === 'parent') {
      alerts = alerts.filter((a) => a.audience.includes('parents'));
    } else if (user.role === 'authority_liaison') {
      alerts = alerts.filter((a) => a.audience.includes('authorities') || a.audience.includes('parents'));
    }
    alerts = alerts.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
    return send(res, 200, { alerts });
  }

  if (method === 'GET' && pathname === '/api/alerts/active') {
    const user = requireUser(req, res);
    if (!user) return;
    return send(res, 200, campusStatusPayload());
  }

  if (method === 'POST' && pathname === '/api/admin/alerts') {
    const user = requireUser(req, res, ['safety_admin']);
    if (!user) return;
    const body = await readBody(req);
    const type = body.type;
    if (!ALERT_TEMPLATES[type]) return send(res, 400, { error: 'Unknown alert type' });
    const tmpl = ALERT_TEMPLATES[type];
    const alert = {
      id: uid(),
      campusId: db.campus.id,
      tipId: body.tipId || null,
      type,
      title: body.title || tmpl.title,
      body: body.body || tmpl.body,
      parentGuidance: body.parentGuidance || tmpl.parentGuidance,
      audience: Array.isArray(body.audience) && body.audience.length
        ? body.audience
        : type === 'all_clear'
          ? ['parents', 'staff', 'students', 'authorities']
          : ['parents', 'staff', 'authorities'],
      channels: Array.isArray(body.channels) && body.channels.length ? body.channels : ['sms', 'push', 'email'],
      status: 'sent',
      sentBy: user.id,
      sentAt: now(),
      createdAt: now(),
      nextUpdateMinutes: body.nextUpdateMinutes ?? 15,
    };

    db.alerts.unshift(alert);

    if (type === 'all_clear') {
      db.campus.status = 'all_clear';
    } else if (['lockdown', 'shelter_in_place'].includes(type)) {
      db.campus.status = 'emergency';
    } else if (type === 'avoid_area' || type === 'pickup_change') {
      db.campus.status = 'elevated';
    } else if (type === 'info' && db.campus.status === 'normal') {
      db.campus.status = 'elevated';
    }
    db.campus.statusUpdatedAt = now();

    if (body.tipId) {
      const tip = db.tips.find((t) => t.id === body.tipId);
      if (tip) {
        tip.status = 'alert_sent';
        tip.acknowledgedAt = tip.acknowledgedAt || now();
      }
    }

    queueDeliveries(alert, user);
    audit(db, user.id, 'alert', alert.id, 'sent', { type, audience: alert.audience });
    saveDb(db);
    return send(res, 201, { alert, campus: db.campus, deliveries: db.deliveries.filter((d) => d.alertId === alert.id) });
  }

  // Authority escalation
  if (method === 'POST' && pathname === '/api/admin/escalate') {
    const user = requireUser(req, res, ['safety_admin']);
    if (!user) return;
    const body = await readBody(req);
    const tip = body.tipId ? db.tips.find((t) => t.id === body.tipId) : null;
    const alert = body.alertId ? db.alerts.find((a) => a.id === body.alertId) : null;
    if (!tip && !alert) return send(res, 400, { error: 'tipId or alertId required' });

    const summary =
      body.summary ||
      (tip
        ? `${tip.category} tip (${tip.severityGuess}) — ${tip.description.slice(0, 180)}`
        : `${alert.type}: ${alert.title}`);

    const escalation = {
      id: uid(),
      tipId: tip?.id || null,
      alertId: alert?.id || null,
      campusId: db.campus.id,
      summary,
      contactPhone: db.campus.emergencyContact,
      status: 'sent',
      sentAt: now(),
      ackedAt: null,
      ackedBy: null,
    };
    db.escalations.unshift(escalation);
    if (tip) tip.status = 'escalated';

    // Notify authority users
    for (const authUser of db.users.filter((u) => u.role === 'authority_liaison')) {
      db.deliveries.unshift({
        id: uid(),
        alertId: alert?.id || null,
        escalationId: escalation.id,
        userId: authUser.id,
        channel: 'sms',
        status: 'sent',
        preview: `[AUTHORITY HEADS-UP] ${db.campus.name}: ${summary}`,
        createdAt: now(),
        deliveredAt: now(),
      });
    }

    audit(db, user.id, 'escalation', escalation.id, 'sent', { tipId: tip?.id, alertId: alert?.id });
    saveDb(db);
    return send(res, 201, { escalation });
  }

  if (method === 'GET' && pathname === '/api/authority/incidents') {
    const user = requireUser(req, res, ['authority_liaison', 'safety_admin']);
    if (!user) return;
    const incidents = db.escalations.map((e) => ({
      ...e,
      campusName: db.campus.name,
      tip: e.tipId ? enrichTip(db.tips.find((t) => t.id === e.tipId)) : null,
      alert: e.alertId ? db.alerts.find((a) => a.id === e.alertId) : null,
    }));
    return send(res, 200, { incidents });
  }

  const ackMatch = pathname.match(/^\/api\/authority\/incidents\/([^/]+)\/ack$/);
  if (method === 'POST' && ackMatch) {
    const user = requireUser(req, res, ['authority_liaison']);
    if (!user) return;
    const esc = db.escalations.find((e) => e.id === ackMatch[1]);
    if (!esc) return send(res, 404, { error: 'Incident not found' });
    esc.status = 'acked';
    esc.ackedAt = now();
    esc.ackedBy = user.id;
    audit(db, user.id, 'escalation', esc.id, 'acked', {});
    saveDb(db);
    return send(res, 200, { escalation: esc });
  }

  // Inbox / deliveries for current user (simulated notifications)
  if (method === 'GET' && pathname === '/api/inbox') {
    const user = requireUser(req, res);
    if (!user) return;
    const items = db.deliveries.filter((d) => d.userId === user.id).slice(0, 50);
    return send(res, 200, { items });
  }

  if (method === 'GET' && pathname === '/api/admin/audit') {
    const user = requireUser(req, res, ['safety_admin']);
    if (!user) return;
    return send(res, 200, { audit: db.audit.slice(0, 100) });
  }

  return notFound(res);
}

function demoAccounts() {
  return db.users.map((u) => ({
    email: u.email,
    password: 'demo1234',
    role: u.role,
    fullName: u.fullName,
  }));
}

function sanitizeTipForReporter(tip, user) {
  return {
    id: tip.id,
    category: tip.category,
    happeningNow: tip.happeningNow,
    severityGuess: tip.severityGuess,
    locationText: tip.locationText,
    description: tip.description,
    status: tip.status,
    isAnonymous: tip.isAnonymous,
    createdAt: tip.createdAt,
    mine: tip.reporterUserId === user.id,
  };
}

function enrichTip(tip) {
  if (!tip) return null;
  const reporter = tip.reporterUserId ? db.users.find((u) => u.id === tip.reporterUserId) : null;
  return {
    ...tip,
    reporterName: tip.isAnonymous ? 'Anonymous' : reporter?.fullName || 'Unknown',
    reporterRole: tip.isAnonymous ? 'anonymous' : tip.reporterRole,
    actions: db.tipActions.filter((a) => a.tipId === tip.id),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    if (serveStatic(req, res, url.pathname)) return;
    // SPA fallback
    const index = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(index).pipe(res);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Campus Safety MVP running at http://localhost:${PORT}`);
  console.log('Demo logins (password: demo1234):');
  for (const a of demoAccounts()) {
    console.log(`  ${a.role.padEnd(20)} ${a.email}`);
  }
});
