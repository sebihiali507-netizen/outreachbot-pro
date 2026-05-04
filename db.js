'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// إعداد مسار البيانات بما يتوافق مع Volume الخاص بـ Railway
const DATA_DIR = '/app/data';

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'outreachbot.db');

// دالة الاتصال: تعالج مشكلة تأخر ربط الـ Volume عند بدء التشغيل
function connect() {
    try {
        // مهلة 10 ثوانٍ لضمان جاهزية النظام
        return new Database(DB_FILE, { timeout: 10000 });
    } catch (err) {
        console.error('[DB] Failed to connect, retrying...', err.message);
        // نخرج بكود 1 ليعيد Railway تشغيل الحاوية تلقائياً (Restart Strategy)
        process.exit(1); 
    }
}

const db = connect();

// إعدادات تحسين الأداء لـ SQLite
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

if (process.env.NODE_ENV === 'production') {
    console.log(`[DB] Production mode — database: ${DB_FILE}, data dir: ${DATA_DIR}`);
}

// ── SCHEMA ────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  contact_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  business_type TEXT DEFAULT '',
  city TEXT DEFAULT '',
  website TEXT DEFAULT '',
  sequence_stage INTEGER DEFAULT 0,
  sequence_stopped INTEGER DEFAULT 0,
  last_email_sent TEXT,
  status TEXT DEFAULT 'New',
  revenue_onetime REAL DEFAULT 0,
  revenue_recurring REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  ab_variant TEXT DEFAULT '',
  opened INTEGER DEFAULT 0,
  replied INTEGER DEFAULT 0,
  reply_sentiment TEXT DEFAULT '',
  lead_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_memory (
  phone TEXT PRIMARY KEY,
  lead_id TEXT,
  company TEXT,
  city TEXT,
  sector TEXT,
  lang TEXT DEFAULT 'en',
  has_website INTEGER DEFAULT 0,
  first_seen TEXT DEFAULT (datetime('now')),
  last_contacted TEXT,
  contact_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sequence_log (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  stage INTEGER NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  subject TEXT DEFAULT '',
  ab_variant TEXT DEFAULT '',
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ab_results (
  variant TEXT PRIMARY KEY,
  sent INTEGER DEFAULT 0,
  opened INTEGER DEFAULT 0,
  replied INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  email_from TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  subject TEXT DEFAULT '',
  body_preview TEXT DEFAULT '',
  sentiment TEXT DEFAULT 'other'
);

CREATE TABLE IF NOT EXISTS revenue (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT DEFAULT (date('now')),
  note TEXT DEFAULT '',
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS services_leads (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  website TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO ab_results(variant, sent, opened, replied) VALUES
  ('A', 0, 0, 0),
  ('B', 0, 0, 0),
  ('C', 0, 0, 0);
`);

// ── CONTACTS FUNCTIONS ─────────────────────────────────────────
const contactsGet = db.prepare('SELECT * FROM contacts WHERE id = ?');
const contactsAll = db.prepare('SELECT * FROM contacts ORDER BY created_at DESC');
const contactsInsert = db.prepare(`
  INSERT OR REPLACE INTO contacts
    (id, company, contact_name, email, business_type, city, website,
     sequence_stage, sequence_stopped, last_email_sent, status,
     revenue_onetime, revenue_recurring, notes, ab_variant,
     opened, replied, reply_sentiment, lead_id, created_at)
  VALUES
    (@id, @company, @contact_name, @email, @business_type, @city, @website,
     @sequence_stage, @sequence_stopped, @last_email_sent, @status,
     @revenue_onetime, @revenue_recurring, @notes, @ab_variant,
     @opened, @replied, @reply_sentiment, @lead_id, @created_at)
`);
const contactsUpdate = db.prepare(`
  UPDATE contacts SET
    company=@company, contact_name=@contact_name, email=@email,
    business_type=@business_type, city=@city, website=@website,
    sequence_stage=@sequence_stage, sequence_stopped=@sequence_stopped,
    last_email_sent=@last_email_sent, status=@status,
    revenue_onetime=@revenue_onetime, revenue_recurring=@revenue_recurring,
    notes=@notes, ab_variant=@ab_variant,
    opened=@opened, replied=@replied, reply_sentiment=@reply_sentiment
  WHERE id=@id
`);
const contactsDelete = db.prepare('DELETE FROM contacts WHERE id = ?');
const contactsCount = db.prepare('SELECT COUNT(*) as n FROM contacts');

function getContact(id) { return contactsGet.get(id); }
function getAllContacts() { return contactsAll.all(); }
function upsertContact(c) { return contactsInsert.run(c); }
function updateContact(c) { return contactsUpdate.run(c); }
function deleteContact(id) { return contactsDelete.run(id); }

function searchContacts({ status, city, stage, q } = {}) {
  let sql = 'SELECT * FROM contacts WHERE 1=1';
  const params = {};
  if (status) { sql += ' AND status=@status'; params.status = status; }
  if (city)   { sql += ' AND city LIKE @city'; params.city = `%${city}%`; }
  if (stage != null) { sql += ' AND sequence_stage=@stage'; params.stage = stage; }
  if (q) {
    sql += ' AND (company LIKE @q OR email LIKE @q OR contact_name LIKE @q OR city LIKE @q)';
    params.q = `%${q}%`;
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(params);
}

function markContactReplied(id, sentiment) {
  db.prepare(`UPDATE contacts SET replied=1, reply_sentiment=@sentiment,
    sequence_stopped=1, status='Replied' WHERE id=@id`).run({ id, sentiment });
}

function markContactOpened(id) {
  db.prepare('UPDATE contacts SET opened=1 WHERE id=?').run(id);
}

function advanceSequenceStage(id, stage) {
  db.prepare(`UPDATE contacts SET sequence_stage=@stage, last_email_sent=datetime('now')
    WHERE id=@id`).run({ id, stage });
}

// ── SEQUENCE LOG ──────────────────────────────────────────────
const seqLogInsert = db.prepare(`
  INSERT INTO sequence_log(id, contact_id, stage, sent_at, subject, ab_variant)
  VALUES(@id, @contact_id, @stage, @sent_at, @subject, @ab_variant)
`);
function logSequence(entry) { return seqLogInsert.run(entry); }
function getSequenceLog(contactId) {
  return db.prepare('SELECT * FROM sequence_log WHERE contact_id=? ORDER BY sent_at DESC').all(contactId);
}

function getContactsReadyForStage(stage, daysAfterPrev) {
  return db.prepare(`
    SELECT * FROM contacts
    WHERE sequence_stage=@prevStage
      AND sequence_stopped=0
      AND replied=0
      AND last_email_sent IS NOT NULL
      AND datetime(last_email_sent, '+' || @days || ' days') <= datetime('now')
  `).all({ prevStage: stage - 1, days: daysAfterPrev });
}

// ── A/B TEST ──────────────────────────────────────────────────
let _abCounter = 0;
function nextAbVariant() {
  const variants = ['A', 'B', 'C'];
  const v = variants[_abCounter % 3];
  _abCounter++;
  return v;
}

function recordAbSent(variant) {
  db.prepare('UPDATE ab_results SET sent=sent+1 WHERE variant=?').run(variant);
}
function recordAbOpened(variant) {
  db.prepare('UPDATE ab_results SET opened=opened+1 WHERE variant=?').run(variant);
}
function recordAbReplied(variant) {
  db.prepare('UPDATE ab_results SET replied=replied+1 WHERE variant=?').run(variant);
}
function getAbResults() {
  return db.prepare('SELECT * FROM ab_results ORDER BY variant').all();
}

// ── REPLIES ──────────────────────────────────────────────────
function insertReply(r) {
  db.prepare(`INSERT OR IGNORE INTO replies(id, contact_id, email_from, received_at, subject, body_preview, sentiment)
    VALUES(@id, @contact_id, @email_from, @received_at, @subject, @body_preview, @sentiment)`).run(r);
}
function getAllReplies() {
  return db.prepare('SELECT * FROM replies ORDER BY received_at DESC LIMIT 100').all();
}

// ── REVENUE ──────────────────────────────────────────────────
function addRevenue(r) {
  db.prepare(`INSERT INTO revenue(id, contact_id, type, amount, date, note) VALUES(@id, @contact_id, @type, @amount, @date, @note)`).run(r);
  if (r.type === 'one_time') {
    db.prepare('UPDATE contacts SET revenue_onetime=revenue_onetime+@amount, status="Closed" WHERE id=@id').run({ amount: r.amount, id: r.contact_id });
  } else {
    db.prepare('UPDATE contacts SET revenue_recurring=revenue_recurring+@amount, status="Closed" WHERE id=@id').run({ amount: r.amount, id: r.contact_id });
  }
}
function getRevenueSummary() {
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='one_time' THEN amount ELSE 0 END), 0) as total_onetime,
      COALESCE(SUM(CASE WHEN type='recurring' THEN amount ELSE 0 END), 0) as total_recurring,
      COUNT(DISTINCT contact_id) as clients
    FROM revenue
  `).get();
}
function getRevenueByMonth() {
  return db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
      SUM(CASE WHEN type='one_time' THEN amount ELSE 0 END) as onetime,
      SUM(CASE WHEN type='recurring' THEN amount ELSE 0 END) as recurring
    FROM revenue GROUP BY month ORDER BY month DESC LIMIT 12
  `).all();
}

// ── PIPELINE STATS ────────────────────────────────────────────
function getPipelineStats() {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN sequence_stage>=1 THEN 1 ELSE 0 END), 0) as contacted,
      COALESCE(SUM(CASE WHEN opened=1 THEN 1 ELSE 0 END), 0) as opened,
      COALESCE(SUM(CASE WHEN replied=1 THEN 1 ELSE 0 END), 0) as replied,
      COALESCE(SUM(CASE WHEN status='Interested' THEN 1 ELSE 0 END), 0) as interested,
      COALESCE(SUM(CASE WHEN status='Closed' THEN 1 ELSE 0 END), 0) as closed,
      COALESCE(SUM(CASE WHEN sequence_stage=1 THEN 1 ELSE 0 END), 0) as stage1,
      COALESCE(SUM(CASE WHEN sequence_stage=2 THEN 1 ELSE 0 END), 0) as stage2,
      COALESCE(SUM(CASE WHEN sequence_stage=3 THEN 1 ELSE 0 END), 0) as stage3,
      COALESCE(SUM(CASE WHEN sequence_stage=3 AND sequence_stopped=0 THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN sequence_stopped=1 AND replied=1 THEN 1 ELSE 0 END), 0) as stopped_replied
    FROM contacts
  `).get();
}

// ── SERVICES LEADS ────────────────────────────────────────────
function insertServicesLead(l) {
  db.prepare(`INSERT INTO services_leads(id,name,email,website,message) VALUES(@id,@name,@email,@website,@message)`).run(l);
}

// ── CONTACT MEMORY (Anti-Dup) ──────────────────
const memoryGetByPhone = db.prepare('SELECT * FROM contact_memory WHERE phone = ?');
const memoryInsert = db.prepare(`
  INSERT OR IGNORE INTO contact_memory(phone, lead_id, company, city, sector, lang, has_website, first_seen, last_contacted, contact_count, status, notes)
  VALUES(@phone, @lead_id, @company, @city, @sector, @lang, @has_website, @first_seen, @last_contacted, @contact_count, @status, @notes)
`);
const memoryUpdate = db.prepare(`
  UPDATE contact_memory SET
    lead_id=@lead_id, company=@company, city=@city, sector=@sector,
    lang=@lang, has_website=@has_website, last_contacted=@last_contacted,
    contact_count=@contact_count, status=@status, notes=@notes
  WHERE phone=@phone
`);
const memoryCountNew = db.prepare("SELECT COUNT(*) as n FROM contact_memory WHERE status = 'new' AND has_website = 0");
const memoryAll = db.prepare('SELECT * FROM contact_memory ORDER BY first_seen DESC LIMIT 500');

function getMemoryByPhone(phone) {
  if (!phone || phone.trim().length < 5) return null;
  return memoryGetByPhone.get(phone.trim());
}

function isDuplicatePhone(phone) {
  if (!phone || phone.trim().length < 5) return false;
  return !!memoryGetByPhone.get(phone.trim());
}

function recordMemory(entry) {
  const normalizedPhone = (entry.phone || '').trim();
  if (!normalizedPhone) return null;
  const existing = memoryGetByPhone.get(normalizedPhone);
  if (existing) {
    memoryUpdate.run({
      lead_id: entry.lead_id || existing.lead_id,
      company: entry.company || existing.company,
      city: entry.city || existing.city,
      sector: entry.sector || existing.sector,
      lang: entry.lang || existing.lang,
      has_website: entry.has_website !== undefined ? entry.has_website : existing.has_website,
      last_contacted: entry.last_contacted || existing.last_contacted,
      contact_count: (existing.contact_count || 0) + (entry.increment ? 1 : 0),
      status: entry.status || existing.status,
      notes: entry.notes || existing.notes,
      phone: normalizedPhone
    });
    return { action: 'updated', existing: true };
  } else {
    memoryInsert.run({
      phone: normalizedPhone,
      lead_id: entry.lead_id || '',
      company: entry.company || '',
      city: entry.city || '',
      sector: entry.sector || '',
      lang: entry.lang || 'en',
      has_website: entry.has_website || 0,
      first_seen: entry.first_seen || new Date().toISOString(),
      last_contacted: entry.last_contacted || null,
      contact_count: entry.contact_count || 0,
      status: entry.status || 'new',
      notes: entry.notes || ''
    });
    return { action: 'inserted', existing: false };
  }
}

function markContacted(phone, contactedAt) {
  const normalizedPhone = (phone || '').trim();
  if (!normalizedPhone) return;
  const existing = memoryGetByPhone.get(normalizedPhone);
  if (existing) {
    memoryUpdate.run({
      ...existing,
      last_contacted: contactedAt || new Date().toISOString(),
      contact_count: (existing.contact_count || 0) + 1,
      status: 'contacted',
      phone: normalizedPhone
    });
  }
}

function getNewNoWebsiteCount() { return memoryCountNew.get(); }
function getAllMemory() { return memoryAll.all(); }

// ── EXPORTS ───────────────────────────────────────────────────
module.exports = {
  db,
  getContact, getAllContacts, upsertContact, updateContact, deleteContact,
  searchContacts, markContactReplied, markContactOpened, advanceSequenceStage,
  logSequence, getSequenceLog, getContactsReadyForStage,
  nextAbVariant, recordAbSent, recordAbOpened, recordAbReplied, getAbResults,
  insertReply, getAllReplies,
  addRevenue, getRevenueSummary, getRevenueByMonth,
  getPipelineStats, insertServicesLead,
  contactsCount,
  getMemoryByPhone, isDuplicatePhone, recordMemory, markContacted,
  getNewNoWebsiteCount, getAllMemory
};
