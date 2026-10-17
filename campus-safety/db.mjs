import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'store.json');

function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

const EMPTY = {
  campus: null,
  users: [],
  sessions: [],
  tips: [],
  tipActions: [],
  alerts: [],
  escalations: [],
  deliveries: [],
  audit: [],
};

export function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const seeded = seed();
    saveDb(seeded);
    return seeded;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

export function saveDb(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function audit(db, actorUserId, entityType, entityId, event, metadata = {}) {
  db.audit.unshift({
    id: uid(),
    actorUserId,
    entityType,
    entityId,
    event,
    metadata,
    createdAt: now(),
  });
}

export function resetDb() {
  const seeded = seed();
  saveDb(seeded);
  return seeded;
}

function seed() {
  const campusId = uid();
  const adminId = uid();
  const parentId = uid();
  const staffId = uid();
  const studentId = uid();
  const authorityId = uid();
  const t = now();

  const users = [
    {
      id: adminId,
      email: 'safety@lincoln-hs.demo',
      password: 'demo1234',
      fullName: 'Jordan Hale',
      role: 'safety_admin',
      phone: '+1-555-0101',
      campusId,
      childName: null,
      notifySms: true,
      notifyPush: true,
      notifyEmail: true,
      criticalOnly: false,
    },
    {
      id: parentId,
      email: 'parent@demo.com',
      password: 'demo1234',
      fullName: 'Alex Rivera',
      role: 'parent',
      phone: '+1-555-0102',
      campusId,
      childName: 'Sam Rivera',
      notifySms: true,
      notifyPush: true,
      notifyEmail: true,
      criticalOnly: false,
    },
    {
      id: staffId,
      email: 'teacher@lincoln-hs.demo',
      password: 'demo1234',
      fullName: 'Casey Nguyen',
      role: 'staff',
      phone: '+1-555-0103',
      campusId,
      childName: null,
      notifySms: true,
      notifyPush: true,
      notifyEmail: true,
      criticalOnly: false,
    },
    {
      id: studentId,
      email: 'student@demo.com',
      password: 'demo1234',
      fullName: 'Sam Rivera',
      role: 'student_reporter',
      phone: null,
      campusId,
      childName: null,
      notifySms: false,
      notifyPush: true,
      notifyEmail: false,
      criticalOnly: false,
    },
    {
      id: authorityId,
      email: 'sro@citypd.demo',
      password: 'demo1234',
      fullName: 'Officer Morgan Lee',
      role: 'authority_liaison',
      phone: '+1-555-0911',
      campusId,
      childName: null,
      notifySms: true,
      notifyPush: true,
      notifyEmail: true,
      criticalOnly: false,
    },
  ];

  return {
    ...EMPTY,
    campus: {
      id: campusId,
      name: 'Lincoln High School',
      timezone: 'America/Chicago',
      status: 'normal',
      statusUpdatedAt: t,
      address: '1200 Oak Street',
      inviteCode: 'LINCOLN-PARENT',
      emergencyContact: '+1-555-0101',
    },
    users,
    sessions: [],
    tips: [],
    tipActions: [],
    alerts: [],
    escalations: [],
    deliveries: [],
    audit: [
      {
        id: uid(),
        actorUserId: null,
        entityType: 'system',
        entityId: campusId,
        event: 'seeded',
        metadata: { note: 'Demo campus ready for pilot' },
        createdAt: t,
      },
    ],
  };
}

export { uid, now };
