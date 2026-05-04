'use strict';
require('dotenv').config();
const express    = require('express');
const nodemailer = require('nodemailer');
const fetch      = require('node-fetch');
const { v4: uuid } = require('uuid');
const fs   = require('fs');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const dns  = require('dns');
const puppeteer = require('puppeteer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── NEW MODULES ───────────────────────────────────────────────
const crmDb = require('./db');
const registerApiRoutes = require('./api-routes');
const { runSequenceFollowUps, clearTransporterCache } = require('./sequences');
const { checkReplies } = require('./reply-detector');

// ── GEMINI AI CLIENT ──────────────────────────────────────────
let geminiAI = null;
function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!geminiAI) geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return geminiAI;
}

async function generateAIEmail(lead, audit, _retry) {
  const ai = getGeminiClient();
  if (!ai) return null;
  try {
    const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const senderName = process.env.SENDER_NAME || 'SA';
    const hasWebsite = lead.hasWebsite;

    const countryLang = detectCountryLanguage(lead);

    const prompt = hasWebsite
      ? generateWebsiteAuditPrompt(lead, audit, senderName)
      : generateNoWebsitePrompt(lead, countryLang, senderName);

    const subjectPrompt = hasWebsite
      ? generateSubjectPrompt(lead, audit)
      : `Write ONE short email subject line (max 60 chars) for an email to "${lead.company}" about their missing website. Write it in ${countryLang.languageName}. Return ONLY the subject text.`;

    const bodyResult    = await model.generateContent(prompt);
    const body          = bodyResult.response.text().trim();
    await sleep(1200);
    const subjectResult = await model.generateContent(subjectPrompt);
    const subject       = subjectResult.response.text().trim().replace(/^["']|["']$/g, '');
    return { subject, body, aiGenerated: true };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('429') && !_retry) {
      const match = msg.match(/retry in (\d+)(\.\d+)?s/i);
      const waitSec = match ? (parseInt(match[1]) + 2) : 45;
      console.log(`[AI] Rate limited — waiting ${waitSec}s before retry...`);
      await sleep(waitSec * 1000);
      return generateAIEmail(lead, audit, true);
    }
    console.error('[AI] generateAIEmail error:', msg.slice(0, 120));
    return null;
  }
}

const COUNTRY_LANG_MAP = {
  ae: { lang: 'ar', name: 'Arabic' },
  sa: { lang: 'ar', name: 'Arabic' },
  qa: { lang: 'ar', name: 'Arabic' },
  kw: { lang: 'ar', name: 'Arabic' },
  eg: { lang: 'ar', name: 'Arabic' },
  gb: { lang: 'en', name: 'English' },
  us: { lang: 'en', name: 'English' },
  ca: { lang: 'en', name: 'English' },
  fr: { lang: 'fr', name: 'French' },
  de: { lang: 'de', name: 'German' },
  es: { lang: 'es', name: 'Spanish' },
  it: { lang: 'it', name: 'Italian' },
  nl: { lang: 'nl', name: 'Dutch' },
  pt: { lang: 'pt', name: 'Portuguese' },
  br: { lang: 'pt', name: 'Portuguese' },
  mx: { lang: 'es', name: 'Spanish' },
  ar: { lang: 'es', name: 'Spanish' },
  sg: { lang: 'en', name: 'English' },
  hk: { lang: 'en', name: 'English' },
  jp: { lang: 'ja', name: 'Japanese' },
  kr: { lang: 'ko', name: 'Korean' },
  in: { lang: 'en', name: 'English' },
  au: { lang: 'en', name: 'English' },
  ng: { lang: 'en', name: 'English' },
  ke: { lang: 'en', name: 'English' },
  za: { lang: 'en', name: 'English' },
  th: { lang: 'th', name: 'Thai' },
  my: { lang: 'en', name: 'English' },
  id: { lang: 'id', name: 'Indonesian' },
  ph: { lang: 'en', name: 'English' },
  pl: { lang: 'pl', name: 'Polish' },
  se: { lang: 'sv', name: 'Swedish' },
  no: { lang: 'no', name: 'Norwegian' },
  dk: { lang: 'da', name: 'Danish' },
  at: { lang: 'de', name: 'German' },
  ch: { lang: 'de', name: 'German' },
  be: { lang: 'fr', name: 'French' },
  gr: { lang: 'el', name: 'Greek' },
  il: { lang: 'he', name: 'Hebrew' },
  pk: { lang: 'en', name: 'English' },
  bd: { lang: 'en', name: 'English' },
  lk: { lang: 'en', name: 'English' },
  nz: { lang: 'en', name: 'English' },
  tr: { lang: 'tr', name: 'Turkish' },
};

function detectCountryLanguage(lead) {
  const gl = lead.gl || '';
  return COUNTRY_LANG_MAP[gl] || { lang: 'en', name: 'English' };
}

function generateNoWebsitePrompt(lead, langInfo, senderName) {
  return `You are a digital growth consultant making a "Technical Observation" — NOT a sales pitch.

Lead Name: ${lead.company}
Lead Location: ${lead.city}
Niche: ${lead.sector}
Status: Found via Google Maps, verified NO website.

Write a short outreach message in ${langInfo.name} (${langInfo.lang}).

Rules:
- NOT a sales pitch — it must be a Technical Observation
- Mention that their business is visible on Google Maps but lacks a digital gateway (website), which results in losing mobile customers
- State you have already created a Glassmorphism UI mockup specifically for ${lead.company} to show them how a modern site would look
- Keep it under 100 words
- Professional and helpful tone
- End with: "I can send you the mockup — would you like to see it?"
- Sign off as: ${senderName}
- Write ONLY the message body, no subject line, no intro text`;
}

function generateWebsiteAuditPrompt(lead, audit, senderName) {
  const issues = (audit && audit.issues && audit.issues.length) ? audit.issues.join(', ') : 'no major technical issues found';
  const lossAmt = `$${getEffectiveLoss(audit, lead.sector).toLocaleString('en-US')}/month`;
  const score   = (audit && audit.score != null) ? audit.score : 'N/A';

  const specificFlaw = (() => {
    const issueList = (audit && audit.issues && audit.issues.length) ? audit.issues : [];
    if (issueList.some(i => /mobile/i.test(i))) return 'missing mobile click-to-call button (most of your visitors are on phones)';
    if (issueList.some(i => /ssl/i.test(i))) return 'missing SSL certificate (browsers show a security warning to visitors)';
    if (issueList.some(i => /slow|speed/i.test(i))) return 'slow page load — site takes over 4 seconds on mobile, most visitors leave before it loads';
    if (issueList.some(i => /construct/i.test(i))) return '"Under Construction" page still live — you\'re invisible to potential customers searching right now';
    return 'no online booking system — you\'re losing clients who search at night or on weekends';
  })();

  const langInfo = detectCountryLanguage(lead);

  return `You are a digital growth consultant doing a "Realistic Audit" cold outreach. Write in ${langInfo.name} (${langInfo.lang}).

Write a SHORT cold email (max 180 words) to the owner of "${lead.company}", a ${lead.sector || 'business'} in ${lead.city}.

Audit data:
- Site score: ${score}/100
- Key flaw found: ${specificFlaw}
- All issues: ${issues}
- Estimated revenue loss: ${lossAmt}

Rules:
- Start with "Hi,"
- Second sentence: state the ONE specific flaw you found
- Briefly explain why this costs them money
- Offer: free prototype or short screen-recording showing exactly how you'd fix it — zero commitment
- End with: "I can send you a free prototype or a short video showing exactly how I'd fix this for ${lead.company}. Would you like to see it?"
- Sign off as: ${senderName}
- No markdown, headers, or bullet symbols except ✅ for the offer
- No unsubscribe footer
- Write ONLY the email body, no subject line`;
}

function generateSubjectPrompt(lead, audit) {
  const lossAmt = lead.hasWebsite ? `$${getEffectiveLoss(audit, lead.sector).toLocaleString('en-US')}/month` : '';
  const score   = (audit && audit.score != null) ? audit.score : 'N/A';
  const langInfo = detectCountryLanguage(lead);

  if (lead.hasWebsite) {
    return `Write ONE compelling cold email subject line (max 60 chars) for an email about website issues causing revenue loss of ${lossAmt} for "${lead.company}". Write it in ${langInfo.name}. Use urgency if score < 60. Return ONLY the subject line text, nothing else. Score: ${score}`;
  }
  return `Write ONE short email subject line (max 60 chars) for an email to "${lead.company}" about their missing website. Write it in ${langInfo.name}. Return ONLY the subject text.`;
}

async function generateEmailTemplate(lead, sender, audit) {
  const aiResult = await generateAIEmail(lead, audit);
  if (aiResult) return aiResult;
  const tType = lead.hasWebsite ? 'has_website' : 'no_website';
  const lang  = lead.lang || 'en';
  return (T[tType][lang] || T[tType]['en'])(lead, sender, audit);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

function ensureSerperKey() {
  if (process.env.SERPER_API_KEY) return true;
  const envPath = path.join(__dirname, '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const match = raw.match(/^SERPER_API_KEY\s*=\s*(.+)$/m);
    if (match && match[1]) {
      process.env.SERPER_API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
      return true;
    }
  } catch {}
  console.log('[Search] SERPER_API_KEY is not set');
  return false;
}

ensureSerperKey();

// ── ENV FILE MANAGEMENT ──────────────────────────────────────
const ENV_FILE = path.join(__dirname, '.env');

function readEnvFile() {
  try { return fs.readFileSync(ENV_FILE, 'utf8'); } catch { return ''; }
}

function parseEnvFile(content) {
  const vars = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  });
  return vars;
}

function writeEnvFile(vars) {
  const lines = Object.entries(vars).map(([k, v]) => {
    const needsQuotes = /[\s#"']/.test(v);
    return `${k}=${needsQuotes ? '"' + String(v).replace(/"/g, '\\"') + '"' : v}`;
  });
  try { fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n'); } catch {}
}

function applyEnvVars(vars) {
  Object.entries(vars).forEach(([k, v]) => { if (v !== null) process.env[k] = String(v); });
  _transporters && _transporters.clear();
  geminiAI = null; // reset so it re-initialises with new key if changed
  accountHealth.clear();
}

function isQueuedLead(item) {
  if (!item) return false;
  const status = String(item.status || '').toLowerCase();
  if (item.sent || item.emailSent || item.failed) return false;
  const isQueued = !status || status === 'pending' || status === 'queued';
  console.log(`[Queue] isQueuedLead: ${item.company || 'unknown'}, status=${status}, result=${isQueued}`);
  return isQueued;
}

const SENSITIVE_KEYS = new Set([
  'SMTP_PASS','SMTP_APP_PASSWORD','APP_PASSWORD','GEMINI_API_KEY','ADMIN_PASSWORD',
  ...Array.from({length:10},(_,i)=>`SMTP_PASS_${i+1}`)
]);

const SETTINGS_KEYS = [
  'SENDER_NAME','DAILY_EMAIL_CAP','PER_ACCOUNT_DAILY_CAP','CRON_SCHEDULE',
  'EMAIL_DELAY_MIN_MS','EMAIL_DELAY_MAX_MS','GEMINI_API_KEY','SERPER_API_KEY','ADMIN_PASSWORD',
  'SEQ_DAYS_1_TO_2','SEQ_DAYS_2_TO_3','PRICING_WEBSITE','PRICING_MONTHLY',
  'CALENDLY_LINK','ADMIN_EMAIL','IMAP_HOST','IMAP_PORT',
  'SMTP_USER','SMTP_PASS','SMTP_HOST','SMTP_PORT',
  ...Array.from({length:10},(_,i)=>[`SMTP_USER_${i+1}`,`SMTP_PASS_${i+1}`]).flat()
];

function adminAuthMiddleware(req, res, next) {
  const adminPass = process.env.ADMIN_PASSWORD || 'sa2024';
  const token = req.headers['x-admin-token'] || req.query.token || '';
  if (token !== adminPass) return res.status(401).json({ error:'Unauthorized' });
  next();
}

// ── DATA FILES ───────────────────────────────────────────────
const DATA_DIR          = path.join(__dirname, 'data');
const LEADS_FILE        = path.join(DATA_DIR, 'leads.json');
const CAMPS_FILE        = path.join(DATA_DIR, 'campaigns.json');
const QUEUE_FILE        = path.join(DATA_DIR, 'queue.json');
const DOMAINS_FILE      = path.join(DATA_DIR, 'contacted_domains.json');
const FAILED_LEADS_FILE = path.join(DATA_DIR, 'failed_leads.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
['[]','[]','[]','[]','[]'].forEach((d, i) => {
  const f = [LEADS_FILE, CAMPS_FILE, QUEUE_FILE, DOMAINS_FILE, FAILED_LEADS_FILE][i];
  if (!fs.existsSync(f)) fs.writeFileSync(f, d);
});

const readJ  = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } };
const writeJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// ── STATE ────────────────────────────────────────────────────
let botRunning    = false;
let botAborted    = false;
let cronJob       = null;
let cronRunning   = false;
let cronSendLock  = false;
let cronLastFired = null;
let totalSentToday = 0;
let accountIdx    = 0;
let sseClients    = [];
let currentStats  = { found:0, withSite:0, noSite:0, sent:0, skipped:0, audited:0, queued:0, phase:'idle' };

function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  sseClients.forEach(r => { try { r.write(msg); } catch {} });
  console.log(`[${new Date().toISOString()}] [${obj.type}] ${obj.message || ''}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function randomDelay() {
  const min = parseInt(process.env.EMAIL_DELAY_MIN_MS || '120000');  // 2 min default
  const max = parseInt(process.env.EMAIL_DELAY_MAX_MS || '300000');  // 5 min default
  return sleep(Math.floor(Math.random() * (max - min) + min));
}

// ── ACCOUNT POOL ─────────────────────────────────────────────
function getAccountPool() {
  // Option A: SMTP_ACCOUNTS='[{"user":"a@g.com","pass":"xxx"},...]'
  if (process.env.SMTP_ACCOUNTS) {
    try {
      const p = JSON.parse(process.env.SMTP_ACCOUNTS);
      if (Array.isArray(p) && p.length) return p;
    } catch {}
  }
  const appPass = process.env.SMTP_APP_PASSWORD || process.env.APP_PASSWORD || '';
  // Option B: SMTP_USER_1/PASS_1 … SMTP_USER_10/PASS_10
  const pool = [];
  for (let i = 1; i <= 10; i++) {
    const user = process.env[`SMTP_USER_${i}`];
    const pass = String(process.env[`SMTP_PASS_${i}`] || appPass).replace(/\s+/g, '');
    if (user && pass) pool.push({ user, pass });
  }
  if (pool.length) return pool;
  // Option C: single SMTP_USER / SMTP_PASS
  if (process.env.SMTP_USER && (process.env.SMTP_PASS || appPass)) {
    return [{ user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS || appPass).replace(/\s+/g, '') }];
  }
  return [];
}

function normalizeSmtpHost(host) {
  if (!host) return 'smtp.gmail.com';
  const value = String(host).trim();
  if (!value) return 'smtp.gmail.com';
  return value.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function getSmtpConfig(account) {
  // Force Gmail SSL on 465 — app passwords require SSL, not STARTTLS
  const rawHost = account.host || process.env.SMTP_HOST || 'smtp.gmail.com';
  const host = normalizeSmtpHost(rawHost) || 'smtp.gmail.com';
  const defaultPort = host.includes('gmail') ? 465 : 587;
  const port = parseInt(account.port || process.env.SMTP_PORT || String(defaultPort));
  const secure = port === 465; // true for SSL (Gmail 465), false for STARTTLS (587)
  return { host, port, secure, requireTLS: !secure };
}

function smtpErrorMessage(err) {
  return String(err?.response || err?.message || 'SMTP error').replace(/\s+/g, ' ').trim();
}

// ── EMAIL VALIDATOR ───────────────────────────────────────────
const BLOCKED_PREFIXES = ['noreply','no-reply','donotreply','do-not-reply','bounce','mailer-daemon','postmaster','abuse','spam','unsubscribe','support@support','test@','admin@admin','info@info'];
const GENERIC_INFO_PATTERN = /^info@(info|mail|email|contact|website|web)\./i;
const RANDOM_PATTERN = /^[a-z0-9]{12,}@/i; // long random-looking prefix

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(e)) return false;
  if (BLOCKED_PREFIXES.some(p => e.startsWith(p))) return false;
  if (GENERIC_INFO_PATTERN.test(e)) return false;
  if (RANDOM_PATTERN.test(e)) return false;
  const domain = e.split('@')[1] || '';
  if (/example\.|test\.|invalid$|localhost/i.test(domain)) return false;
  return true;
}

// ── BOUNCE DETECTION ──────────────────────────────────────────
function isBounceError(err) {
  const msg = String(err?.response || err?.message || '').toLowerCase();
  return msg.includes('address not found') ||
         msg.includes('user unknown') ||
         msg.includes('no such user') ||
         msg.includes('mailbox not found') ||
         msg.includes('does not exist') ||
         msg.includes('invalid address') ||
         msg.includes('recipient rejected') ||
         msg.includes('550') ||
         msg.includes('551') ||
         msg.includes('553');
}

// ── BOUNCE COOLDOWN STATE ─────────────────────────────────────
let consecutiveBounces  = 0;
let bounceCooldownUntil = null;
const BOUNCE_THRESHOLD  = 3;
const BOUNCE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

function isInBounceCooldown() {
  if (!bounceCooldownUntil) return false;
  if (Date.now() < bounceCooldownUntil) return true;
  bounceCooldownUntil = null;
  consecutiveBounces  = 0;
  return false;
}

function recordBounce(company, email, reason) {
  consecutiveBounces++;
  broadcast({ type: 'bounce_detected', message: `⚠ Bounce #${consecutiveBounces}: ${company} <${email}> — ${reason}`, company, email });
  if (consecutiveBounces >= BOUNCE_THRESHOLD) {
    bounceCooldownUntil = Date.now() + BOUNCE_COOLDOWN_MS;
    consecutiveBounces  = 0;
    broadcast({ type: 'bounce_cooldown', message: `🛑 ${BOUNCE_THRESHOLD} consecutive bounces — pausing 15 minutes to protect email reputation.` });
  }
}

function recordSuccess() {
  consecutiveBounces = 0; // reset on any success
}

// ── FAILED LEADS LOGGER ───────────────────────────────────────
function logFailedLead(item, reason, email) {
  try {
    const failed = readJ(FAILED_LEADS_FILE);
    const existing = failed.find(f => f.id === item.id || (f.email && f.email === email));
    if (!existing) {
      failed.push({
        id:       item.id,
        company:  item.company,
        city:     item.city,
        sector:   item.sector,
        email:    email || item.email,
        website:  item.website,
        reason,
        failedAt: new Date().toISOString()
      });
      writeJ(FAILED_LEADS_FILE, failed);
    }
  } catch {}
}

// ── ACCOUNT HEALTH ───────────────────────────────────────────
const accountHealth = new Map();
// { status:'ok'|'error'|'unknown', errorMsg:'', sentCount:0, lastUsed:null }

function getHealth(user) { return accountHealth.get(user) || { status:'unknown', sentCount:0, lastUsed:null }; }

function loadSentDomains() {
  return new Set(readJ(DOMAINS_FILE));
}

function loadExistingLeadKeys(leads) {
  return new Set(leads.map(l => `${(l.company||'').toLowerCase()}__${(l.city||'').toLowerCase()}__${(l.email||'').toLowerCase()}`));
}

function isDuplicateLead(candidate, leads, queue) {
  const key = `${(candidate.company||'').toLowerCase()}__${(candidate.city||'').toLowerCase()}__${(candidate.email||'').toLowerCase()}`;
  const all = [...leads, ...queue];
  return all.some(l => `${(l.company||'').toLowerCase()}__${(l.city||'').toLowerCase()}__${(l.email||'').toLowerCase()}` === key || (candidate.website && getDomain(candidate.website) && getDomain(l.website) === getDomain(candidate.website)));
}

const PER_ACCOUNT_DAILY_CAP = parseInt(process.env.PER_ACCOUNT_DAILY_CAP || '100');

function todayStr() { return new Date().toISOString().slice(0, 10); } // "YYYY-MM-DD"

function markAccountOk(user) {
  const h = getHealth(user);
  const today = todayStr();
  const prevDate = h.sentDate || '';
  const sentToday = prevDate === today ? (h.sentToday || 0) + 1 : 1;
  accountHealth.set(user, {
    ...h,
    status: 'ok',
    sentCount: (h.sentCount || 0) + 1,
    sentToday,
    sentDate: today,
    lastUsed: new Date().toISOString()
  });
  broadcast({ type:'account_ok', account:user, sentCount:(h.sentCount||0)+1, sentToday });
  totalSentToday++;
}

function markAccountError(user, errMsg) {
  const h = getHealth(user);
  accountHealth.set(user, { ...h, status:'error', errorMsg:errMsg, lastUsed:new Date().toISOString() });
  broadcast({ type:'account_error', account:user, message:`Account error: ${user.split('@')[0]}… — ${errMsg}` });
}

function getSentCountToday(user) {
  const h = getHealth(user);
  if ((h.sentDate || '') !== todayStr()) return 0;
  return h.sentToday || 0;
}

function isAccountCapped(user) {
  return getSentCountToday(user) >= PER_ACCOUNT_DAILY_CAP;
}

// ── SENDER MODE ──────────────────────────────────────────────
let senderMode = 'rotation';      // 'rotation' | 'specific'
let selectedAccountUser = null;   // used when mode is 'specific'

const _transporters = new Map();
function getTransporter(account) {
  // Reset cached transporter if it was previously marked as errored
  if (getHealth(account.user).status === 'error') _transporters.delete(account.user);
  if (!_transporters.has(account.user)) {
    const smtp = getSmtpConfig(account);
    _transporters.set(account.user, nodemailer.createTransport({
      host:   smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: smtp.requireTLS,
      auth:   { user: account.user, pass: account.pass }
    }));
  }
  return _transporters.get(account.user);
}

function nextHealthyAccount(pool) {
  // Skip errored or daily-capped accounts; try all positions before giving up
  for (let i = 0; i < pool.length; i++) {
    const acc = pool[accountIdx % pool.length];
    accountIdx = (accountIdx + 1) % pool.length;
    const h = getHealth(acc.user);
    if (h.status !== 'error' && !isAccountCapped(acc.user)) return acc;
  }
  // All accounts either errored or capped — find one that's only capped (not errored) as last resort
  for (let i = 0; i < pool.length; i++) {
    const acc = pool[accountIdx % pool.length];
    accountIdx = (accountIdx + 1) % pool.length;
    if (getHealth(acc.user).status !== 'error') return acc;
  }
  // Everything errored — return next anyway so the error is logged
  const acc = pool[accountIdx % pool.length];
  accountIdx = (accountIdx + 1) % pool.length;
  return acc;
}

function getAccountForSend(pool) {
  if (senderMode === 'specific' && selectedAccountUser) {
    const acc = pool.find(a => a.user === selectedAccountUser);
    if (acc) return acc;
  }
  return nextHealthyAccount(pool);
}

function isAuthError(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('invalid credentials') || msg.includes('username and password') ||
         msg.includes('authentication failed') || msg.includes('535') || msg.includes('534') ||
         msg.includes('app password') || msg.includes('authorization failed');
}

// ── SEARCH MATRIX ─────────────────────────────────────────────
const GLOBAL_SECTORS = [
  'law firm', 'solicitor', 'attorney', 'legal services',
  'dental clinic', 'dentist', 'orthodontist', 'cosmetic dentist',
  'aesthetic clinic', 'beauty clinic', 'medspa', 'cosmetic clinic',
  'medical clinic', 'doctor', 'physician', 'health clinic',
  'real estate agency', 'property agent', 'realtor',
  'plumbing service', 'plumber', 'pipe repair',
  'hvac contractor', 'air conditioning', 'heating contractor',
  'restaurant', 'cafe', 'bistro', 'diner',
  'accountant', 'accounting firm', 'bookkeeper', 'tax advisor',
  'cleaning service', 'landscaping', 'electrician', 'locksmith', 'pest control',
  'car dealership', 'auto repair', 'mechanic',
  'architecture firm', 'interior designer',
  'marketing agency', 'advertising agency',
  'construction company', 'contractor', 'roofing contractor', 'roof repair',
  'fitness center', 'gym', 'personal trainer',
  'veterinary clinic', 'pet grooming',
  'pharmacy', 'drugstore',
  'bakery', 'catering service',
  'photography studio', 'wedding photographer',
  'insurance agency', 'insurance broker',
];

const SEARCH_MATRIX = [
  { city:'New York',    gl:'us', hl:'en', lang:'en', ll:'40.7128,-74.0060' },
  { city:'Los Angeles', gl:'us', hl:'en', lang:'en', ll:'34.0522,-118.2437' },
  { city:'Chicago',     gl:'us', hl:'en', lang:'en', ll:'41.8781,-87.6298' },
  { city:'Houston',     gl:'us', hl:'en', lang:'en', ll:'29.7604,-95.3698' },
  { city:'Miami',       gl:'us', hl:'en', lang:'en', ll:'25.7617,-80.1918' },
  { city:'London',      gl:'gb', hl:'en', lang:'en', ll:'51.5074,-0.1278' },
  { city:'Manchester',  gl:'gb', hl:'en', lang:'en', ll:'53.4808,-2.2426' },
  { city:'Birmingham',  gl:'gb', hl:'en', lang:'en', ll:'52.4862,-1.8904' },
  { city:'Paris',       gl:'fr', hl:'fr', lang:'fr', ll:'48.8566,2.3522' },
  { city:'Lyon',        gl:'fr', hl:'fr', lang:'fr', ll:'45.7640,4.8357' },
  { city:'Dubai',       gl:'ae', hl:'en', lang:'en', ll:'25.2048,55.2708' },
  { city:'Abu Dhabi',   gl:'ae', hl:'ar', lang:'ar', ll:'24.4539,54.3773' },
  { city:'Riyadh',      gl:'sa', hl:'ar', lang:'ar', ll:'24.7136,46.6753' },
  { city:'Jeddah',      gl:'sa', hl:'ar', lang:'ar', ll:'21.5433,39.1728' },
  { city:'Doha',        gl:'qa', hl:'en', lang:'en', ll:'25.2854,51.5310' },
  { city:'Kuwait City', gl:'kw', hl:'ar', lang:'ar', ll:'29.3759,47.9774' },
  { city:'Singapore',   gl:'sg', hl:'en', lang:'en', ll:'1.3521,103.8198' },
  { city:'Hong Kong',   gl:'hk', hl:'en', lang:'en', ll:'22.3193,114.1694' },
  { city:'Tokyo',       gl:'jp', hl:'ja', lang:'ja', ll:'35.6762,139.6503' },
  { city:'Osaka',       gl:'jp', hl:'ja', lang:'ja', ll:'34.6937,135.5023' },
  { city:'Seoul',       gl:'kr', hl:'ko', lang:'ko', ll:'37.5665,126.9780' },
  { city:'Mumbai',      gl:'in', hl:'en', lang:'en', ll:'19.0760,72.8777' },
  { city:'Delhi',       gl:'in', hl:'en', lang:'en', ll:'28.7041,77.1025' },
  { city:'Bangalore',   gl:'in', hl:'en', lang:'en', ll:'12.9716,77.5946' },
  { city:'Sydney',      gl:'au', hl:'en', lang:'en', ll:'-33.8688,151.2093' },
  { city:'Melbourne',   gl:'au', hl:'en', lang:'en', ll:'-37.8136,144.9631' },
  { city:'Brisbane',    gl:'au', hl:'en', lang:'en', ll:'-27.4698,153.0251' },
  { city:'Toronto',     gl:'ca', hl:'en', lang:'en', ll:'43.6532,-79.3832' },
  { city:'Vancouver',   gl:'ca', hl:'en', lang:'en', ll:'49.2827,-123.1207' },
  { city:'Montreal',    gl:'ca', hl:'en', lang:'en', ll:'45.5017,-73.5673' },
  { city:'Berlin',      gl:'de', hl:'de', lang:'de', ll:'52.5200,13.4050' },
  { city:'Munich',      gl:'de', hl:'de', lang:'de', ll:'48.1351,11.5820' },
  { city:'Amsterdam',   gl:'nl', hl:'nl', lang:'nl', ll:'52.3676,4.9041' },
  { city:'Madrid',      gl:'es', hl:'es', lang:'es', ll:'40.4168,-3.7038' },
  { city:'Barcelona',   gl:'es', hl:'es', lang:'es', ll:'41.3851,2.1734' },
  { city:'Rome',        gl:'it', hl:'it', lang:'it', ll:'41.9028,12.4964' },
  { city:'Milan',       gl:'it', hl:'it', lang:'it', ll:'45.4642,9.1900' },
  { city:'Istanbul',    gl:'tr', hl:'tr', lang:'tr', ll:'41.0082,28.9784' },
  { city:'São Paulo',   gl:'br', hl:'pt', lang:'pt', ll:'-23.5505,-46.6333' },
  { city:'Rio de Janeiro', gl:'br', hl:'pt', lang:'pt', ll:'-22.9068,-43.1729' },
  { city:'Mexico City', gl:'mx', hl:'es', lang:'es', ll:'19.4326,-99.1332' },
  { city:'Buenos Aires', gl:'ar', hl:'es', lang:'es', ll:'-34.6037,-58.3816' },
  { city:'Lagos',       gl:'ng', hl:'en', lang:'en', ll:'6.5244,3.3792' },
  { city:'Nairobi',     gl:'ke', hl:'en', lang:'en', ll:'-1.2921,36.8219' },
  { city:'Cairo',       gl:'eg', hl:'ar', lang:'ar', ll:'30.0444,31.2357' },
  { city:'Johannesburg', gl:'za', hl:'en', lang:'en', ll:'-26.2041,28.0473' },
  { city:'Bangkok',     gl:'th', hl:'th', lang:'th', ll:'13.7563,100.5018' },
  { city:'Kuala Lumpur', gl:'my', hl:'en', lang:'en', ll:'3.1390,101.6869' },
  { city:'Jakarta',     gl:'id', hl:'id', lang:'id', ll:'-6.2088,106.8456' },
  { city:'Manila',      gl:'ph', hl:'en', lang:'en', ll:'14.5995,120.9842' },
  { city:'Warsaw',      gl:'pl', hl:'pl', lang:'pl', ll:'52.2297,21.0122' },
  { city:'Stockholm',   gl:'se', hl:'sv', lang:'sv', ll:'59.3293,18.0686' },
  { city:'Oslo',        gl:'no', hl:'no', lang:'no', ll:'59.9139,10.7522' },
  { city:'Copenhagen',  gl:'dk', hl:'da', lang:'da', ll:'55.6761,12.5683' },
  { city:'Vienna',      gl:'at', hl:'de', lang:'de', ll:'48.2082,16.3738' },
  { city:'Zurich',      gl:'ch', hl:'de', lang:'de', ll:'47.3769,8.5417' },
  { city:'Brussels',    gl:'be', hl:'fr', lang:'fr', ll:'50.8503,4.3517' },
  { city:'Lisbon',      gl:'pt', hl:'pt', lang:'pt', ll:'38.7223,-9.1393' },
  { city:'Athens',      gl:'gr', hl:'el', lang:'el', ll:'37.9838,23.7275' },
  { city:'Tel Aviv',    gl:'il', hl:'he', lang:'he', ll:'32.0853,34.7818' },
  { city:'Karachi',     gl:'pk', hl:'en', lang:'en', ll:'24.8607,67.0011' },
  { city:'Lahore',      gl:'pk', hl:'en', lang:'en', ll:'31.5204,74.3587' },
  { city:'Dhaka',       gl:'bd', hl:'en', lang:'en', ll:'23.8103,90.4125' },
  { city:'Colombo',     gl:'lk', hl:'en', lang:'en', ll:'6.9271,79.8612' },
  { city:'Auckland',    gl:'nz', hl:'en', lang:'en', ll:'-36.8485,174.7633' },
  { city:'Edinburgh',   gl:'gb', hl:'en', lang:'en', ll:'55.9533,-3.1883' },
  { city:'Leeds',       gl:'gb', hl:'en', lang:'en', ll:'53.8008,-1.5491' },
  { city:'Liverpool',   gl:'gb', hl:'en', lang:'en', ll:'53.4084,-2.9916' },
  { city:'Phoenix',     gl:'us', hl:'en', lang:'en', ll:'33.4484,-112.0740' },
  { city:'Dallas',      gl:'us', hl:'en', lang:'en', ll:'32.7767,-96.7970' },
  { city:'San Francisco', gl:'us', hl:'en', lang:'en', ll:'37.7749,-122.4194' },
  { city:'Seattle',     gl:'us', hl:'en', lang:'en', ll:'47.6062,-122.3321' },
  { city:'Boston',      gl:'us', hl:'en', lang:'en', ll:'42.3601,-71.0589' },
  { city:'Atlanta',     gl:'us', hl:'en', lang:'en', ll:'33.7490,-84.3880' },
  { city:'Las Vegas',   gl:'us', hl:'en', lang:'en', ll:'36.1699,-115.1398' },
  { city:'Denver',      gl:'us', hl:'en', lang:'en', ll:'39.7392,-104.9903' },
];

// ── CITY MAP (for targeted search) ───────────────────────────
const CITY_MAP = {
  'New York':    { gl:'us', hl:'en', lang:'en', ll:'40.7128,-74.0060' },
  'Los Angeles': { gl:'us', hl:'en', lang:'en', ll:'34.0522,-118.2437' },
  'London':      { gl:'gb', hl:'en', lang:'en', ll:'51.5074,-0.1278' },
  'Paris':       { gl:'fr', hl:'fr', lang:'fr', ll:'48.8566,2.3522' },
  'Dubai':       { gl:'ae', hl:'en', lang:'en', ll:'25.2048,55.2708' },
  'Abu Dhabi':   { gl:'ae', hl:'en', lang:'en', ll:'24.4539,54.3773' },
  'Singapore':   { gl:'sg', hl:'en', lang:'en', ll:'1.3521,103.8198' },
  'Hong Kong':   { gl:'hk', hl:'en', lang:'en', ll:'22.3193,114.1694' },
  'São Paulo':   { gl:'br', hl:'pt', lang:'pt', ll:'-23.5505,-46.6333' },
  'Sydney':      { gl:'au', hl:'en', lang:'en', ll:'-33.8688,151.2093' },
  'Melbourne':   { gl:'au', hl:'en', lang:'en', ll:'-37.8136,144.9631' },
};

// ── TARGETED SECTOR PRESETS ───────────────────────────────────
const SECTOR_PRESETS = {
  'law_firm':        ['law firm', 'solicitor', 'attorney', 'legal services', 'immigration lawyer', 'criminal lawyer', 'divorce lawyer'],
  'dental':          ['dental clinic', 'dentist', 'orthodontist', 'cosmetic dentist'],
  'aesthetic':       ['aesthetic clinic', 'beauty clinic', 'medspa', 'cosmetic clinic'],
  'medical':         ['medical clinic', 'doctor', 'physician', 'health clinic'],
  'real_estate':     ['real estate agency', 'property agent', 'realtor'],
  'plumbing':        ['plumbing service', 'plumber', 'pipe repair'],
  'hvac':            ['hvac contractor', 'air conditioning', 'heating contractor'],
  'restaurant':      ['restaurant', 'cafe', 'bistro', 'diner'],
  'accounting':      ['accountant', 'accounting firm', 'bookkeeper', 'tax advisor'],
  'local_services':  ['cleaning service', 'landscaping', 'electrician', 'locksmith', 'pest control'],
};

// ── AUDIT ENGINE ─────────────────────────────────────────────
const UC_PHRASES = ['under construction','coming soon','maintenance mode','be back soon','launching soon','pardon our dust','site en construction','قيد الإنشاء','em construção'];

async function analyzeWebsite(website) {
  const result = { email:null, score:100, ssl:true, speedMs:null, underConstruction:false, noMobile:false, issues:[] };
  if (!website) return result;

  const normalize = u => u.startsWith('http') ? u : 'https://' + u;
  const httpsUrl  = normalize(website).replace(/^http:\/\//i, 'https://');
  const httpUrl   = httpsUrl.replace('https://', 'http://');

  const tryFetch = async (url, ms = 7000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const t0 = Date.now();
      const r  = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, redirect: 'follow' });
      clearTimeout(t);
      return { ok: true, html: await r.text(), speedMs: Date.now() - t0 };
    } catch { clearTimeout(t); return { ok: false }; }
  };

  const extractEmail = html => {
    const m = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
    if (m) return m[1].toLowerCase();
    const all = (html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
      .filter(e => !['noreply','no-reply','@2x','@3x','.png','.jpg','.gif','.svg','.webp','@sentry','@example','@google','@facebook'].some(x => e.toLowerCase().includes(x)) && e.split('@')[1].includes('.'));
    return all[0] ? all[0].toLowerCase() : null;
  };

  // Try HTTPS
  let page = await tryFetch(httpsUrl);
  if (!page.ok) {
    result.ssl = false; result.score -= 30; result.issues.push('no SSL certificate');
    page = await tryFetch(httpUrl);
  }

  if (page.ok) {
    result.speedMs = page.speedMs;
    const lower = page.html.toLowerCase();

    if (UC_PHRASES.some(p => lower.includes(p))) {
      result.underConstruction = true; result.score -= 40; result.issues.push('under construction');
    }
    if (!lower.includes('viewport')) {
      result.noMobile = true; result.score -= 10; result.issues.push('not mobile-friendly');
    }
    if (page.speedMs > 3000) {
      result.score -= 20; result.issues.push(`slow (${(page.speedMs/1000).toFixed(1)}s)`);
    }
    result.email = extractEmail(page.html);
  }

  // Layer 2: try /contact /about
  if (!result.email) {
    const base = httpsUrl.replace(/\/$/, '');
    for (const slug of ['/contact', '/contact-us', '/about', '/kontakt']) {
      const pg = await tryFetch(base + slug, 4000);
      if (!pg.ok) continue;
      const e = extractEmail(pg.html);
      if (e) { result.email = e; break; }
    }
  }

  // Layer 3: info@domain fallback
  if (!result.email) {
    try {
      const domain = new URL(httpsUrl).hostname.replace('www.', '');
      result.email = `info@${domain}`;
    } catch {}
  }

  result.score = Math.max(0, result.score);

  // ── ESTIMATED MONTHLY REVENUE LOSS ───────────────────────
  let loss = 0;
  if (!result.ssl)              loss += 1200;  // trust/conversion drop
  if (result.underConstruction) loss += 3500;  // 100% traffic wasted
  if (result.speedMs > 3000)    loss += 900;   // 53% bounce-rate uplift
  if (result.noMobile)          loss += 650;   // 60%+ traffic is mobile
  result.estimatedLoss = loss;

  return result;
}

// ── DEAD URL DETECTION ────────────────────────────────────────
async function isDeadUrl(url) {
  if (!url) return false;
  const normalized = url.startsWith('http') ? url : 'https://' + url;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(normalized, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow'
    });
    clearTimeout(t);
    return res.status >= 400;
  } catch {
    clearTimeout(t);
    return true;
  }
}

// ── EMAIL MX VALIDATION ───────────────────────────────────────
async function validateEmailMX(email) {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1];
  if (!domain) return false;
  try {
    const records = await dns.promises.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

// ── SECTOR BASELINE LOSS (when technical audit finds no issues) ──
function getSectorBaseline(sector) {
  if (!sector) return 1500;
  const s = sector.toLowerCase();
  if (/aesthetic|cosmetic|beauty|spa|medspa/i.test(s))                     return 4500;
  if (/dental|dentist|orthodont/i.test(s))                                  return 3200;
  if (/medical|clinic|doctor|physician|health|chiropract/i.test(s))         return 2800;
  if (/real estate|realtor|property|immobil|agence|agência/i.test(s))       return 6500;
  if (/hvac|air cond|heating|cooling|clim/i.test(s))                        return 2200;
  if (/plumb|pipe|sewer|plom|encan/i.test(s))                               return 1800;
  if (/lawyer|attorney|law firm|legal|solicitor|avocat|abogado/i.test(s))   return 3800;
  if (/restaurant|café|cafe|food|catering/i.test(s))                        return 1800;
  if (/gym|fitness|yoga|pilates|studio/i.test(s))                           return 2000;
  return 1500; // general default
}

// Returns the effective loss: technical audit loss OR a sector-based minimum
function getEffectiveLoss(audit, sector) {
  const tech = (audit && audit.estimatedLoss) ? audit.estimatedLoss : 0;
  if (tech > 0) return tech;
  // No technical issues found — still losing revenue from missing booking automation
  return getSectorBaseline(sector);
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────
function issueLines(audit, lang) {
  if (!audit || !audit.issues || !audit.issues.length) return '';
  const I = {
    en: { h:'Issues detected on your site:', nossl:'❌ Missing SSL — browsers warn visitors "Not Secure"', slow:`⚠ Slow load time (${audit.speedMs?(audit.speedMs/1000).toFixed(1)+'s':''}) — you lose 53% of visitors after 3 seconds`, uc:'🚧 Site appears under construction', mob:'📱 Not optimised for mobile (60%+ of traffic is mobile)' },
    fr: { h:'Problèmes détectés:', nossl:'❌ SSL manquant — navigateurs affichent "Non sécurisé"', slow:`⚠ Chargement lent (${audit.speedMs?(audit.speedMs/1000).toFixed(1)+'s':''}) — 53% des visiteurs partent après 3 secondes`, uc:'🚧 Site semble en construction', mob:'📱 Non optimisé pour mobile' },
    ar: { h:'مشاكل وُجدت في موقعكم:', nossl:'❌ شهادة SSL مفقودة — المتصفحات تعرض "غير آمن"', slow:`⚠ بطء في التحميل (${audit.speedMs?(audit.speedMs/1000).toFixed(1)+'ث':''}) — تخسرون 53% من الزوار بعد 3 ثوانٍ`, uc:'🚧 الموقع تحت الإنشاء', mob:'📱 غير متوافق مع الجوال' },
    pt: { h:'Problemas encontrados no seu site:', nossl:'❌ SSL ausente — navegadores exibem "Não Seguro"', slow:`⚠ Carregamento lento (${audit.speedMs?(audit.speedMs/1000).toFixed(1)+'s':''}) — você perde 53% dos visitantes após 3 segundos`, uc:'🚧 Site parece em construção', mob:'📱 Não otimizado para mobile' }
  };
  const L = I[lang] || I.en;
  const lines = [L.h];
  if (audit.issues.includes('no SSL certificate'))   lines.push(L.nossl);
  if (audit.issues.some(i => i.includes('slow')))    lines.push(L.slow);
  if (audit.underConstruction)                        lines.push(L.uc);
  if (audit.noMobile)                                 lines.push(L.mob);
  return lines.join('\n');
}

function lossLine(audit, lang) {
  if (!audit || !audit.estimatedLoss) return '';
  const loss = audit.estimatedLoss.toLocaleString('en-US');
  const L = {
    en: `💸 Estimated revenue loss: ~$${loss}/month`,
    fr: `💸 Perte de revenus estimée : ~${loss} $/mois`,
    ar: `💸 الخسارة المتوقعة في الإيرادات: ~${loss}$ شهرياً`,
    pt: `💸 Perda de receita estimada: ~$${loss}/mês`
  };
  return L[lang] || L.en;
}

function auditFinished(audit) {
  return !!(audit && (audit.score != null || audit.issues || audit.estimatedLoss != null));
}

function setLeadStatus(leads, id, status) {
  const idx = leads.findIndex(l => l.id === id);
  if (idx !== -1) leads[idx].emailStatus = status;
}

const T = {
  has_website: {
    en: (l, s, audit) => {
      const iss  = issueLines(audit, 'en');
      const effectiveLoss = getEffectiveLoss(audit, l.sector);
      const lossAmt = effectiveLoss.toLocaleString('en-US');
      const urgent = audit && audit.score < 60;
      const industry = l.sector || 'your industry';
      const niche = /clinic|dental|aesthetic|medical|orthodontist/i.test(industry) ? 'clinic' : /real estate|agency|immobil|property/i.test(industry) ? 'business' : /plumb|hvac|home services|service/i.test(industry) ? 'service company' : 'business';
      return {
        subject: urgent
          ? `⚠ ${l.company}'s website is leaking ~$${lossAmt}/month`
          : `Site audit for ${l.company} — revenue loss found`,
        body: `Hi,\n\nI audited ${l.company}'s website after finding you while researching ${industry} ${niche}s in ${l.city}.\n\n${iss ? iss + '\n\n' : ''}Your site is leaking approximately $${lossAmt} every month. Even when clients do find you, they can't book instantly — which means you're losing them to competitors who can.\n\nHere's what I'm offering:\n✅ A free prototype showing exactly how an automated booking system would look on your website — no commitment needed\n\nI can send you a free prototype or a short video showing exactly how I'd fix this for ${l.company}. Would you like to see it?\n\nBest,\n${s}`
      };
    },
    fr: (l, s, audit) => {
      const iss  = issueLines(audit, 'fr');
      const lossAmt = getEffectiveLoss(audit, l.sector).toLocaleString('fr-FR');
      const industry = l.sector || 'votre secteur';
      const niche = /clinique|dentaire|esthétique|médical/i.test(industry) ? 'cabinet' : /immobilier|agence/i.test(industry) ? 'entreprise' : /plomb|clim/i.test(industry) ? 'société de services' : 'entreprise';
      return {
        subject: audit && audit.score < 60
          ? `⚠ Le site de ${l.company} perd ~${lossAmt} $/mois`
          : `Audit du site de ${l.company} — fuites de revenus détectées`,
        body: `Bonjour,\n\nJ'ai audité le site de ${l.company} après vous avoir trouvé en cherchant des ${industry} ${niche}s à ${l.city}.\n\n${iss ? iss + '\n\n' : ''}Votre site perd environ ${lossAmt} $ chaque mois. Même quand les clients vous trouvent, ils ne peuvent pas réserver instantanément — et ils partent chez vos concurrents.\n\nVoici ce que je propose :\n✅ Un prototype gratuit montrant exactement comment un système de réservation automatisé s'intégrerait sur votre site — sans engagement\n\nJe peux vous envoyer un prototype gratuit ou une courte vidéo montrant exactement comment je règlerais ça pour ${l.company}. Souhaitez-vous le voir ?\n\nCordialement,\n${s}`
      };
    },
    ar: (l, s, audit) => {
      const iss  = issueLines(audit, 'ar');
      const lossAmt = getEffectiveLoss(audit, l.sector).toLocaleString('ar-SA');
      const industry = l.sector || 'مجالكم';
      const niche = /عيادة|أسنان|تجميل|طبية/i.test(industry) ? 'عيادة' : /عقار|إيجار|تأجير/i.test(industry) ? 'شركة' : /صيانة|سباكة|تكييف/i.test(industry) ? 'شركة خدمات' : 'شركة';
      return {
        subject: audit && audit.score < 60
          ? `⚠ موقع ${l.company} يخسر ~${lossAmt}$ شهرياً`
          : `تحليل موقع ${l.company} — خسائر في الإيرادات`,
        body: `مرحباً،\n\nقمتُ بتحليل موقع ${l.company} بعد أن وجدتكم أثناء بحثي عن ${industry} ${niche}s في ${l.city}.\n\n${iss ? iss + '\n\n' : ''}موقعكم يُسرّب ما يقارب ${lossAmt}$ شهرياً. حتى عندما يجدكم العملاء، لا يستطيعون الحجز فوراً — فيذهبون إلى منافسيكم.\n\nإليكم ما أعرضه:\n✅ نموذج أولي مجاني يُظهر بالضبط كيف سيبدو نظام الحجز الآلي على موقعكم — بدون أي التزام\n\nيمكنني إرسال لكم نموذجاً أولياً مجانياً أو فيديو قصيراً يُظهر بالضبط كيف سأحل هذا لـ ${l.company}. هل تودّون رؤيته؟\n\nمع التحية،\n${s}`
      };
    },
    pt: (l, s, audit) => {
      const iss  = issueLines(audit, 'pt');
      const lossAmt = getEffectiveLoss(audit, l.sector).toLocaleString('pt-BR');
      const industry = l.sector || 'seu setor';
      const niche = /clínica|odont|estétic|médic/i.test(industry) ? 'empresa' : /imobili|corretor|imóvel/i.test(industry) ? 'empresa' : /encan|ar cond|hvac|manuten/i.test(industry) ? 'empresa de serviços' : 'empresa';
      return {
        subject: audit && audit.score < 60
          ? `⚠ O site de ${l.company} está perdendo ~R$${lossAmt}/mês`
          : `Auditoria do site de ${l.company} — perda de receita identificada`,
        body: `Olá,\n\nAnalisei o site de ${l.company} após encontrá-los pesquisando ${industry} ${niche}s em ${l.city}.\n\n${iss ? iss + '\n\n' : ''}Seu site está perdendo aproximadamente $${lossAmt} por mês. Mesmo quando clientes te encontram, eles não conseguem agendar na hora — e vão para a concorrência.\n\nAqui está o que estou oferecendo:\n✅ Um protótipo gratuito mostrando exatamente como um sistema de agendamento automatizado ficaria no seu site — sem compromisso\n\nPosso te enviar um protótipo gratuito ou um vídeo curto mostrando exatamente como eu resolveria isso para ${l.company}. Gostaria de ver?\n\nAtenciosamente,\n${s}`
      };
    }
  },
  no_website: {
    en: (l, s) => {
      const industry = l.sector || 'your industry';
      return {
        subject: `${l.company} — your ${industry} clients can't find you on Google`,
        body: `Hi,\n\nI found ${l.company} while searching for ${industry} businesses in ${l.city}.\n\nYou don't have a website — in 2025 that means roughly 80% of people searching for ${industry} services on Google simply can't find you. That's missed revenue every single day.\n\nI can send you a free prototype or a short video showing exactly how I'd fix this for ${l.company}. Would you like to see it?\n\nBest,\n${s}`
      };
    },
    fr: (l, s) => {
      const industry = l.sector || 'votre secteur';
      return {
        subject: `${l.company} — vos clients ${industry} ne vous trouvent pas sur Google`,
        body: `Bonjour,\n\nJ'ai trouvé ${l.company} en cherchant des ${industry} à ${l.city}.\n\nVous n'avez pas de site web — en 2025, 80 % des internautes cherchant des services ${industry} sur Google ne peuvent pas vous trouver. C'est du chiffre d'affaires perdu chaque jour.\n\nJe peux vous envoyer un prototype gratuit ou une courte vidéo montrant exactement comment je règlerais ça pour ${l.company}. Souhaitez-vous le voir ?\n\nCordialement,\n${s}`
      };
    },
    ar: (l, s) => {
      const industry = l.sector || 'مجالكم';
      return {
        subject: `${l.company} — عملاء ${industry} لا يجدونكم على Google`,
        body: `مرحباً،\n\nوجدتُ ${l.company} أثناء بحثي عن ${industry} في ${l.city}.\n\nلا تملكون موقعاً إلكترونياً — في عام 2025 هذا يعني أن 80% من الباحثين عن خدمات ${industry} على Google لا يجدونكم. هذا إيراد ضائع كل يوم.\n\nيمكنني إرسال لكم نموذجاً أولياً مجانياً أو فيديو قصيراً يُظهر بالضبط كيف سأحل هذا لـ ${l.company}. هل تودّون رؤيته؟\n\nمع التحية،\n${s}`
      };
    },
    pt: (l, s) => {
      const industry = l.sector || 'seu setor';
      return {
        subject: `${l.company} — seus clientes de ${industry} não te encontram no Google`,
        body: `Olá,\n\nEncontrei ${l.company} pesquisando ${industry} em ${l.city}.\n\nVocê não tem site — em 2025 isso significa que 80% das pessoas buscando serviços de ${industry} no Google simplesmente não te acham. Isso é receita perdida todo dia.\n\nPosso te enviar um protótipo gratuito ou um vídeo curto mostrando exatamente como eu resolveria isso para ${l.company}. Gostaria de ver?\n\nAtenciosamente,\n${s}`
      };
    }
  }
};

// ── PUPPETEER GOOGLE MAPS SCRAPER ────────────────────────────
let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser && (await sharedBrowser.pages()).length > 0) return sharedBrowser;
  const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH
    || '/usr/bin/google-chrome-stable'
    || '/usr/bin/brave-browser';
  console.log(`[Puppeteer] Launching browser: ${chromePath} (headless: new)`);
  sharedBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-extensions',
      '--disable-hang-monitor',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--single-process',
      '--ignore-certificate-errors'
    ]
  });
  return sharedBrowser;
}

async function humanDelay(min = 2000, max = 5000) {
  const delay = min + Math.floor(Math.random() * (max - min));
  await sleep(delay);
}

async function scrapeGoogleMaps(sector, city, ll, maxResults = 100) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const results = [];
  const seen = new Set();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );

  const query = encodeURIComponent(`${sector} in ${city}`);
  const url = ll
    ? `https://www.google.com/maps/search/${query}/@${ll},12z/data=!3m1!4b1`
    : `https://www.google.com/maps/search/${query}`;

  console.log(`[Maps] Navigating: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await humanDelay(3000, 5000);

  try {
    await page.waitForSelector('[role="feed"]', { timeout: 15000 });
  } catch {
    console.log(`[Maps] No feed found for ${sector} in ${city}`);
    await page.close();
    return results;
  }

  for (let scroll = 0; scroll < 15; scroll++) {
    if (results.length >= maxResults) break;
    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (feed) feed.scrollTop = feed.scrollHeight;
    });
    await humanDelay(1500, 3000);
  }

  const items = await page.evaluate(() => {
    const feed = document.querySelector('[role="feed"]');
    if (!feed) return [];
    const cards = feed.querySelectorAll('div[role="article"]');
    const data = [];
    cards.forEach(card => {
      const nameEl = card.querySelector('div[aria-label]');
      const name = nameEl ? nameEl.getAttribute('aria-label') : '';
      const allText = card.innerText || '';
      const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);

      let phone = '';
      let address = '';
      let website = '';
      let rating = 0;
      let reviewsCount = 0;

      for (const line of lines) {
        if (/^\+?\d[\d\s\-()]{6,}$/.test(line) || /^[\d\s\-()]{6,}$/.test(line)) {
          if (!phone) phone = line;
        } else if (/^\d+\s/.test(line) && /[A-Za-z]{2,}/.test(line) && !line.includes('@')) {
          if (!address) address = line;
        } else if (/\/www\./.test(line) || /\.(com|net|org|io|co|info|biz|dev|app|shop|store|online|site|website)/.test(line.toLowerCase())) {
          if (!website) website = line;
        }
        const ratingMatch = line.match(/(\d+\.?\d*)\s*\(/);
        if (ratingMatch && !rating) {
          rating = parseFloat(ratingMatch[1]);
          const revMatch = line.match(/\((\d[\d,]*)/);
          if (revMatch) reviewsCount = parseInt(revMatch[1].replace(/,/g, ''));
        }
      }

      const links = card.querySelectorAll('a');
      links.forEach(a => {
        const href = a.getAttribute('href') || '';
        if (href.includes('/url?q=') || href.includes('www.')) {
          try {
            const urlMatch = href.match(/\/url\?q=(https?:\/\/[^&]+)/);
            if (urlMatch && !website) website = decodeURIComponent(urlMatch[1]);
          } catch {}
        }
      });

      if (name) data.push({ title: name, phone, address, website, rating, reviewsCount });
    });
    return data;
  });

  for (const item of items) {
    if (results.length >= maxResults) break;
    const key = (item.title || '').trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
  }

  await page.close();
  console.log(`[Maps] ${sector} in ${city}: ${results.length} results scraped`);
  return results;
}

async function searchGoogleMapsMulti(city, gl, hl, lang, ll, sectors) {
  const results = [];
  const seen = new Set();
  const searchSectors = sectors && sectors.length ? sectors : GLOBAL_SECTORS;

  console.log(`[Maps] Starting city: ${city}, sectors: ${searchSectors.length}`);

  for (const sector of searchSectors) {
    try {
      await humanDelay(3000, 6000);
      console.log(`[Maps] Scraping: ${sector} in ${city}`);
      const places = await scrapeGoogleMaps(sector, city, ll, 60);
      let added = 0;
      for (const place of places) {
        const key = `${(place.title || '').trim().toLowerCase()}__${city.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ ...place, sector, lang });
          added++;
        }
      }
      console.log(`[Maps] ${city} / ${sector}: ${added} new (total: ${results.length})`);
    } catch (err) {
      console.log(`[Maps] Error ${city} / ${sector}: ${err.message}`);
    }
  }
  console.log(`[Maps] City complete: ${results.length} total for ${city}`);
  return results;
}

// ── DOMAIN DEDUP ─────────────────────────────────────────────
function getDomain(website) {
  if (!website) return null;
  try { return new URL(website.startsWith('http') ? website : 'https://' + website).hostname.replace('www.', '').toLowerCase(); }
  catch { return null; }
}

// ── QUEUE ─────────────────────────────────────────────────────
const getQueue    = () => readJ(QUEUE_FILE);
const writeQueue  = q  => writeJ(QUEUE_FILE, q);
const queueLength = () => getQueue().filter(i => !i.sent && !i.failed).length;

function addToQueue(items) {
  const q = getQueue();
  const ids = new Set(q.map(i => i.id));
  const leads = readJ(LEADS_FILE);
  let addedCount = 0;
  let dupCount = 0;
  items.forEach(i => {
    if (ids.has(i.id)) { dupCount++; return; }
    if (isDuplicateLead(i, leads, q)) { dupCount++; return; }
    // Ensure status is set to 'queued' so cron scheduler picks it up
    if (!i.status) i.status = 'queued';
    q.push(i);
    addedCount++;
  });
  writeQueue(q);
  console.log(`[Queue] addToQueue: ${addedCount} added, ${dupCount} duplicates skipped (total in queue: ${q.length})`);
}

function getNextQueued() {
  const q = getQueue();
  const pending = q.filter(i => !i.sent && !i.failed);
  console.log(`[Queue] getNextQueued: ${q.length} total, ${pending.length} pending items`);
  if (pending.length > 0) {
    console.log(`[Queue] First pending: ${pending[0].company} (${pending[0].city}), status=${pending[0].status}, email=${pending[0].email || 'none'}`);
  }
  return pending[0] || null;
}

function markQueueItem(id, patch) {
   const q = getQueue();
   const item = q.find(i => i.id === id);
   if (item) {
     if (patch.sent)   { item.sent = true;   item.sentAt = new Date().toISOString(); item.email = patch.email || ''; item.accountUsed = patch.accountUsed || ''; item.status = 'Sent'; }
     if (patch.failed) { item.failed = true; item.failedAt = new Date().toISOString(); item.status = 'Failed'; }
     writeQueue(q);
   }
}

// ── CRON SCHEDULER (auto-send from queue) ─────────────────────
function startCronScheduler() {
  if (cronRunning) { console.log('[Cron] Already running'); return true; }
  const pool = getAccountPool();
  if (!pool.length) { console.log('[Cron] No SMTP accounts — skipping auto-send'); return false; }

  const schedule = process.env.CRON_SCHEDULE || '*/2 * * * *';
  console.log(`[Cron] Starting scheduler with schedule: ${schedule}`);

  cronJob = cron.schedule(schedule, async () => {
    if (cronSendLock || isInBounceCooldown()) return;
    if (cronRunning) return;
    cronRunning = true;
    cronSendLock = true;

    try {
      const dailyCap = parseInt(process.env.DAILY_EMAIL_CAP || '200');
      if (totalSentToday >= dailyCap) {
        console.log(`[Cron] Daily cap reached (${totalSentToday}/${dailyCap}) — skipping`);
        return;
      }

      const item = getNextQueued();
      if (!item || !isQueuedLead(item)) {
        console.log('[Cron] Queue empty – nothing to send');
        return;
      }

      console.log(`[Cron] Processing queued lead: ${item.company} (${item.city})`);
      const sender = process.env.SENDER_NAME || 'SA';
      const account = getAccountForSend(pool);
      const audit = item.audit || {};

      // Re-audit if needed and website exists
      let emailTo = item.email || '';
      if (!emailTo && item.hasWebsite && item.website) {
        try {
          const freshAudit = await analyzeWebsite(item.website);
          emailTo = freshAudit.email || `info@${getDomain(item.website)}`;
          audit.score = freshAudit.score;
          audit.issues = freshAudit.issues;
          audit.estimatedLoss = freshAudit.estimatedLoss || 0;
          // Update queue
          const q2 = getQueue();
          const qi = q2.find(x => x.id === item.id);
          if (qi) { qi.email = emailTo; qi.audit = audit; writeQueue(q2); }
        } catch {
          emailTo = `info@${getDomain(item.website)}`;
        }
      } else if (!emailTo && !item.hasWebsite) {
        // No website lead — cannot send without email
        console.log(`[Cron] No email for ${item.company} — marking failed`);
        markQueueItem(item.id, { failed: true });
        return;
      }

      if (!emailTo || !isValidEmail(emailTo)) {
        console.log(`[Cron] Invalid email for ${item.company}: ${emailTo} — marking failed`);
        markQueueItem(item.id, { failed: true });
        logFailedLead(item, 'Invalid or missing email', emailTo);
        return;
      }

      // Generate template
      const lead = { company: item.company, city: item.city, sector: item.sector, hasWebsite: item.hasWebsite, website: item.website, lang: item.lang || 'en' };
      const tmpl = await generateEmailTemplate(lead, sender, audit);

      // Send email
      let sendOk = false;
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const t = getTransporter(account);
          await t.sendMail({ from: { name: sender, address: account.user }, to: emailTo, subject: tmpl.subject, text: tmpl.body });
          sendOk = true;
          break;
        } catch (err) {
          lastErr = err;
          if (isAuthError(err)) { markAccountError(account.user, smtpErrorMessage(err)); break; }
          if (attempt < 3) await sleep(2000 * attempt);
        }
      }

      if (sendOk) {
        recordSuccess();
        markAccountOk(account.user);
        markQueueItem(item.id, { sent: true, email: emailTo, accountUsed: account.user });
        currentStats.sent++;
        totalSentToday++;
        // Sync to leads file
        const leads = readJ(LEADS_FILE);
        const idx = leads.findIndex(l => l.id === item.id);
        if (idx !== -1) { leads[idx].emailSent = true; leads[idx].email = emailTo; leads[idx].sentAt = new Date().toISOString(); leads[idx].accountUsed = account.user; writeJ(LEADS_FILE, leads); }
        // Track domain
        const domain = getDomain(item.website);
        if (domain) { const domains = readJ(DOMAINS_FILE); if (!domains.includes(domain)) { domains.push(domain); writeJ(DOMAINS_FILE, domains); } }
        // Mark in memory as contacted
        const memPhone = (item.phone || '').replace(/\s+/g, '').replace(/[-()]/g, '');
        if (memPhone.length >= 5) crmDb.markContacted(memPhone, new Date().toISOString());
        // Sync to CRM
        try { crmDb.upsertContact({ id: item.id, company: item.company, contact_name: '', email: emailTo, business_type: item.sector || '', city: item.city, website: item.website || '', sequence_stage: 1, sequence_stopped: 0, last_email_sent: new Date().toISOString(), status: 'Contacted', revenue_onetime: 0, revenue_recurring: 0, notes: '', ab_variant: '', opened: 0, replied: 0, reply_sentiment: '', lead_id: item.id }); } catch {}
        broadcast({ type: 'email_sent', message: `✅ Cron sent: ${item.company} (${item.city})`, lead: item.company, city: item.city, email: emailTo, account: account.user, queueLeft: queueLength(), stats: currentStats });
        console.log(`[Cron] Email sent to ${item.company} <${emailTo}>`);
      } else {
        const errMsg = smtpErrorMessage(lastErr);
        const isBnc = isBounceError(lastErr);
        markQueueItem(item.id, { failed: true });
        if (isBnc) recordBounce(item.company, emailTo, errMsg.slice(0, 80));
        logFailedLead(item, isBnc ? 'Bounce' : errMsg, emailTo);
        broadcast({ type: 'email_error', message: `✕ Cron failed: ${item.company} — ${errMsg.slice(0, 60)}`, lead: item.company, queueLeft: queueLength() });
        console.log(`[Cron] Send failed for ${item.company}: ${errMsg}`);
      }

      // Delay before next
      await randomDelay();
    } catch (err) {
      console.error('[Cron] Error:', err.message);
    } finally {
      cronSendLock = false;
      cronRunning = false;
      cronLastFired = new Date().toISOString();
    }
  });

  cronRunning = true;
  broadcast({ type: 'cron_started', message: `Auto-send activated (cap: ${process.env.DAILY_EMAIL_CAP || '200'}/day)` });
  console.log('[Cron] Scheduler started');
  return true;
}

function stopCronScheduler() {
  if (cronJob) { try { cronJob.stop(); } catch {} cronJob = null; }
  cronRunning = false;
  broadcast({ type: 'cron_stopped', message: 'Auto-send stopped.' });
  console.log('[Cron] Scheduler stopped');
}

// ── FULL MATRIX BOT (all cities + sectors) ────────────────────
async function runBot() {
  botRunning = true;
  botAborted = false;
  const campaignId = uuid();
  const startedAt = new Date().toISOString();

  const LEAD_TARGET = 1000;
  const existingLeads = readJ(LEADS_FILE);
  const contactedDomains = new Set(readJ(DOMAINS_FILE));
  const seenKeys = new Set(existingLeads.map(l => `${(l.company || '').toLowerCase()}__${(l.city || '').toLowerCase()}__${(l.email || '').toLowerCase()}`));
  const allNewLeads = [];

  let matrixIndex = 0;
  let loopCount = 0;
  const maxLoops = Math.ceil(LEAD_TARGET / SEARCH_MATRIX.length) + 2;

  currentStats = { found: 0, withSite: 0, noSite: 0, sent: currentStats.sent, skipped: currentStats.skipped, audited: 0, queued: 0, phase: 'searching' };

  broadcast({ type: 'bot_start', message: `Global search: targeting ${LEAD_TARGET} no-website leads across ${SEARCH_MATRIX.length} cities...`, stats: currentStats });

  while (allNewLeads.length < LEAD_TARGET && loopCount < maxLoops && !botAborted) {
    const entry = SEARCH_MATRIX[matrixIndex % SEARCH_MATRIX.length];
    matrixIndex++;
    loopCount++;
    const { city, gl, hl, lang, ll } = entry;
    broadcast({ type: 'search_start', message: `Searching ${city}... (${allNewLeads.length}/${LEAD_TARGET} leads)`, pipeline: city, stats: currentStats });
    try {
      const places = await searchGoogleMapsMulti(city, gl, hl, lang, ll, GLOBAL_SECTORS);
      console.log(`[Search] ${city}: ${places.length} places returned`);
      for (const place of places) {
        if (botAborted || allNewLeads.length >= LEAD_TARGET) break;
        const company = (place.title || '').trim();
        if (!company) continue;
        const leadPhone = place.phone || place.phoneNumber || '';
        const normalizedPhone = leadPhone.replace(/\s+/g, '').replace(/[-()]/g, '');
        if (normalizedPhone.length >= 5 && crmDb.isDuplicatePhone(normalizedPhone)) {
          console.log(`[Memory] Skip duplicate phone: ${leadPhone} — ${company}`);
          continue;
        }
        const key = `${company.toLowerCase()}__${city.toLowerCase()}__${(leadPhone || '').toLowerCase()}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const website = place.website || '';
        if (website) continue;
        const domain = getDomain(website);
        if (domain && contactedDomains.has(domain)) continue;
        const lead = {
          id: uuid(), company, name: company,
          city, sector: place.sector || GLOBAL_SECTORS[0], lang,
          phone: leadPhone,
          address: place.address || '',
          website, rating: parseFloat(place.rating) || 0, reviewsCount: parseInt(place.reviewsCount) || 0,
          hasWebsite: false, email: '', emailSent: false, sentAt: null,
          audit: null, score: null, accountUsed: '', createdAt: new Date().toISOString(), status: 'queued'
        };
        allNewLeads.push(lead);
        if (normalizedPhone.length >= 5) {
          crmDb.recordMemory({
            phone: normalizedPhone, lead_id: lead.id, company, city,
            sector: place.sector || GLOBAL_SECTORS[0], lang,
            has_website: 0, first_seen: new Date().toISOString(),
            last_contacted: null, contact_count: 0, status: 'new', notes: ''
          });
        }
        currentStats.found++;
        currentStats.noSite++;
        console.log(`[Memory] New lead recorded: ${company} (${city}) — phone: ${leadPhone}`);
      }
    } catch (err) {
      console.error(`[Search] ${city} error: ${err.message}`);
      broadcast({ type: 'search_error', message: `${city}: ${err.message}`, pipeline: city });
    }
    if (!botAborted && allNewLeads.length < LEAD_TARGET) {
      await sleep(8000 + Math.floor(Math.random() * 7000));
    }
  }

  broadcast({ type: 'search_done', message: `${allNewLeads.length} no-website leads found (target: ${LEAD_TARGET}) across ${loopCount} city searches`, count: allNewLeads.length, stats: currentStats });

  // Save leads
  writeJ(LEADS_FILE, [...existingLeads, ...allNewLeads]);

  // ── AUDIT + QUEUE ────────────────────────────────────────
  currentStats.phase = 'auditing';
  broadcast({ type: 'audit_phase_start', message: 'Auditing sites and finding emails...', stats: currentStats });

  const queueItems = [];
  for (let i = 0; i < allNewLeads.length; i++) {
    if (botAborted) break;
    const lead = allNewLeads[i];
    const pct = Math.round((i / Math.max(allNewLeads.length, 1)) * 100);
    broadcast({ type: 'progress', progress: pct, processed: i + 1, total: allNewLeads.length, stats: currentStats });

    if (lead.hasWebsite) {
      try {
        const audit = await analyzeWebsite(lead.website);
        lead.audit = { score: audit.score, ssl: audit.ssl, speedMs: audit.speedMs, underConstruction: audit.underConstruction, noMobile: audit.noMobile, issues: audit.issues, estimatedLoss: audit.estimatedLoss || 0 };
        lead.score = audit.score;
        lead.estimatedLoss = audit.estimatedLoss || 0;
        lead.email = audit.email || '';
        currentStats.audited++;
        broadcast({ type: 'audit_done', message: `${lead.company}: ${audit.score}/100`, lead: lead.company, score: audit.score, stats: currentStats });
      } catch { lead.score = 100; }
    }

    if (!lead.hasWebsite) {
      queueItems.push({ ...lead, status: 'queued' });
      currentStats.queued++;
    } else {
      currentStats.skipped++;
    }

    // Update leads file
    const all = readJ(LEADS_FILE);
    const idx = all.findIndex(l => l.id === lead.id);
    if (idx !== -1) { all[idx] = lead; writeJ(LEADS_FILE, all); }
  }

  addToQueue(queueItems);

  // ── CRM SYNC ────────────────────────────────────────────
  try {
    for (const lead of queueItems) {
      crmDb.upsertContact({
        id: lead.id, company: lead.company, contact_name: '',
        email: lead.email || '', business_type: lead.sector || '',
        city: lead.city || '', website: lead.website || '',
        sequence_stage: 0, sequence_stopped: 0, last_email_sent: null,
        status: 'New', revenue_onetime: 0, revenue_recurring: 0,
        notes: 'No website — target for web development services',
        ab_variant: '', opened: 0, replied: 0,
        reply_sentiment: '', lead_id: lead.id,
        created_at: new Date().toISOString()
      });
    }
  } catch (crmErr) { console.error('[CRM] Sync error:', crmErr.message); }

  currentStats.phase = 'queued';
  const campaign = { id: campaignId, startedAt, completedAt: new Date().toISOString(), status: botAborted ? 'aborted' : 'queued', stats: { ...currentStats } };
  const camps = readJ(CAMPS_FILE);
  camps.unshift(campaign);
  writeJ(CAMPS_FILE, camps);
  botRunning = false;

  broadcast({ type: 'bot_complete', message: `Done! ${currentStats.queued} leads queued. ${cronRunning ? 'Auto-send is active.' : 'Press "Start Auto-Send" to begin sending.'}`, stats: currentStats, campaign, queueLeft: queueLength() });
  console.log(`[Bot] Complete: ${currentStats.found} found, ${currentStats.queued} queued`);
}

// ── TARGETED BOT (single city + sectors + filters) ────────────
async function runTargetedBot(options = {}) {
  const {
    city,
    sectorKeys    = [],
    noWebsiteOnly = false,
    validateEmails = false,
    targetCount   = 1000,
  } = options;

  botRunning = true;
  botAborted = false;
  const campaignId  = uuid();
  const startedAt   = new Date().toISOString();

  const cityParams = CITY_MAP[city];
  if (!cityParams) {
    broadcast({ type:'bot_error', message:`Unknown city: ${city}` });
    botRunning = false;
    return;
  }

  // Build sector list from selected preset keys
  let sectors = [];
  for (const key of sectorKeys) {
    const list = SECTOR_PRESETS[key] || [];
    sectors = sectors.concat(list);
  }
  if (!sectors.length) sectors = ['local business', 'service business'];

  const { gl, hl, lang, ll } = cityParams;

  currentStats = { found:0, withSite:0, noSite:0, sent:currentStats.sent, skipped:currentStats.skipped, audited:0, queued:0, emailsVerified:0, deadUrls:0, phase:'searching' };

  const filterLabel = [
    noWebsiteOnly  ? 'No Website/Dead URL only' : 'All',
    validateEmails ? '+ MX validation' : '',
  ].filter(Boolean).join(' ');

  broadcast({ type:'bot_start', message:`Targeted search: ${city} — ${sectorKeys.join(', ')} · ${filterLabel}`, stats:currentStats });

  const existingLeads    = readJ(LEADS_FILE);
  const contactedDomains = new Set(readJ(DOMAINS_FILE));
  const seenKeys         = new Set(existingLeads.map(l => `${(l.company||'').toLowerCase()}__${(l.city||'').toLowerCase()}`));
  const newLeads         = [];

  // ── PHASE 1: SEARCH ──────────────────────────────────────
  broadcast({ type:'search_start', message:`Searching ${city} for: ${sectorKeys.join(', ')}...`, pipeline:city, step:1, total:1, stats:currentStats });
  try {
    const places = await searchGoogleMapsMulti(city, gl, hl, lang, ll, sectors);
    for (const place of places) {
      if (botAborted || newLeads.length >= targetCount) break;
      const company = (place.title || '').trim();
      if (!company) continue;
      const leadPhone = place.phoneNumber || place.phone || '';
      const normalizedPhone = leadPhone.replace(/\s+/g, '').replace(/[-()]/g, '');
      if (normalizedPhone.length >= 5 && crmDb.isDuplicatePhone(normalizedPhone)) {
        console.log(`[Memory] Targeted: Skip duplicate phone: ${leadPhone} — ${company}`);
        continue;
      }
      const key = `${company.toLowerCase()}__${city.toLowerCase()}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const website = place.website || '';
      const domain  = getDomain(website);
      if (domain && contactedDomains.has(domain)) continue;
      const lead = {
        id: uuid(), company, name:company,
        city, sector:place.sector || sectors[0], lang,
        phone:leadPhone,
        address:place.address || '',
        website, rating:parseFloat(place.rating)||0, reviewsCount:parseInt(place.reviewsCount)||0,
        hasWebsite:!!website, email:'', emailSent:false, sentAt:null,
        audit:null, score:null, accountUsed:'', createdAt:new Date().toISOString()
      };
      if (!lead.hasWebsite && normalizedPhone.length >= 5) {
        crmDb.recordMemory({
          phone: normalizedPhone, lead_id: lead.id, company, city,
          sector: place.sector || sectors[0], lang,
          has_website: 0, first_seen: new Date().toISOString(),
          last_contacted: null, contact_count: 0, status: 'new', notes: ''
        });
      }
      newLeads.push(lead);
      currentStats.found++;
      if (lead.hasWebsite) currentStats.withSite++; else currentStats.noSite++;
    }
  } catch (err) {
    broadcast({ type:'search_error', message:`${city}: ${err.message}`, pipeline:city });
  }
  broadcast({ type:'search_done', message:`${city}: ${newLeads.length} leads found`, pipeline:city, count:newLeads.length, stats:currentStats });

  // ── PHASE 1.5: DEAD URL FILTER ────────────────────────────
  let filteredLeads = newLeads;
  if (noWebsiteOnly && !botAborted) {
    broadcast({ type:'audit_phase_start', message:'Filtering: checking for no-website / dead URLs...', stats:currentStats });
    const filtered = [];
    for (const lead of newLeads) {
      if (botAborted) break;
      if (!lead.hasWebsite) {
        filtered.push(lead);
        currentStats.deadUrls++;
      } else {
        const dead = await isDeadUrl(lead.website);
        if (dead) {
          lead.deadUrl = true;
          filtered.push(lead);
          currentStats.deadUrls++;
          broadcast({ type:'auditing', message:`Dead URL confirmed: ${lead.company} (${lead.website})`, lead:lead.company });
        }
      }
    }
    filteredLeads = filtered;
    currentStats.found = filteredLeads.length;
    broadcast({ type:'search_done', message:`Filter done — ${filteredLeads.length} no-website/dead URL leads`, stats:currentStats });
  }

  writeJ(LEADS_FILE, [...existingLeads, ...filteredLeads]);

  // ── PHASE 2: AUDIT + EMAIL DISCOVERY ─────────────────────
  currentStats.phase = 'auditing';
  broadcast({ type:'audit_phase_start', message:'Phase 2: Auditing sites and finding emails...', stats:currentStats });

  const queueItems = [];

  for (let i = 0; i < filteredLeads.length; i++) {
    if (botAborted) break;
    const lead   = filteredLeads[i];
    const pct    = Math.round(50 + (i / Math.max(filteredLeads.length, 1)) * 50);
    broadcast({ type:'progress', progress:pct, processed:i+1, total:filteredLeads.length, stats:currentStats });

    if (lead.hasWebsite && !lead.deadUrl) {
      broadcast({ type:'auditing', message:`Auditing ${lead.company}...`, lead:lead.company });
      try {
        const audit = await analyzeWebsite(lead.website);
        lead.audit = { score:audit.score, ssl:audit.ssl, speedMs:audit.speedMs, underConstruction:audit.underConstruction, noMobile:audit.noMobile, issues:audit.issues, estimatedLoss:audit.estimatedLoss||0 };
        lead.score = audit.score;
        lead.estimatedLoss = audit.estimatedLoss || 0;
        lead.auditFinished = true;
        lead.email = audit.email || '';
        currentStats.audited++;
        broadcast({ type:'audit_done', message:`${lead.company}: ${audit.score}/100${audit.issues.length ? ' — ' + audit.issues.join(', ') : ' ✓'}`, lead:lead.company, score:audit.score, issues:audit.issues, estimatedLoss:audit.estimatedLoss||0, stats:currentStats });
      } catch { lead.score = 100; }
    } else if (lead.deadUrl && lead.website) {
      broadcast({ type:'auditing', message:`Auditing dead site: ${lead.company}...`, lead:lead.company });
      try {
        const audit = await analyzeWebsite(lead.website);
        lead.audit = { score:audit.score, ssl:audit.ssl, speedMs:audit.speedMs, underConstruction:audit.underConstruction, noMobile:audit.noMobile, issues:audit.issues, estimatedLoss:audit.estimatedLoss||0 };
        lead.score = audit.score;
        lead.estimatedLoss = audit.estimatedLoss || 0;
        lead.auditFinished = true;
        lead.email = audit.email || '';
        currentStats.audited++;
        broadcast({ type:'audit_done', message:`Dead URL audit: ${lead.company} — SSL: ${audit.ssl ? 'OK' : 'FAIL'}, Speed: ${audit.speedMs ? (audit.speedMs/1000).toFixed(1)+'s' : 'N/A'}`, lead:lead.company, score:audit.score, issues:audit.issues, estimatedLoss:audit.estimatedLoss||0, stats:currentStats });
      } catch { lead.score = 0; }
    }

    // ── EMAIL MX VALIDATION ──────────────────────────────
    if (validateEmails && lead.email) {
      const valid = await validateEmailMX(lead.email);
      if (!valid) {
        lead.emailMxFailed = true;
        broadcast({ type:'email_skip', message:`MX invalid: ${lead.email} — skipped`, lead:lead.company, queueLeft:queueLength() });
        currentStats.skipped++;
        const all = readJ(LEADS_FILE);
        const idx2 = all.findIndex(l => l.id === lead.id);
        if (idx2 !== -1) { all[idx2] = lead; writeJ(LEADS_FILE, all); }
        continue;
      }
      lead.emailMxVerified = true;
      currentStats.emailsVerified = (currentStats.emailsVerified || 0) + 1;
      broadcast({ type:'audit_done', message:`✓ MX verified: ${lead.email}`, lead:lead.company, stats:currentStats });
    }

    // ── QUEUE DECISION ───────────────────────────────────
    if (lead.email || (lead.hasWebsite && lead.website && !lead.deadUrl)) {
      queueItems.push({ ...lead, status: 'queued' });
      currentStats.queued++;
    } else if (!lead.hasWebsite || lead.deadUrl) {
      queueItems.push({ ...lead, status: 'queued' });
      currentStats.queued++;
    } else {
      currentStats.skipped++;
    }

    const all = readJ(LEADS_FILE);
    const idx = all.findIndex(l => l.id === lead.id);
    if (idx !== -1) { all[idx] = lead; writeJ(LEADS_FILE, all); }
  }

  addToQueue(queueItems);

  // ── CRM SYNC ────────────────────────────────────────────
  try {
    for (const lead of queueItems) {
      const notesParts = [];
      if (lead.deadUrl)          notesParts.push('Dead URL detected');
      if (lead.emailMxVerified)  notesParts.push('Email MX verified');
      if (!lead.hasWebsite)      notesParts.push('No website');
      crmDb.upsertContact({
        id: lead.id, company: lead.company, contact_name: '',
        email: lead.email || '', business_type: lead.sector || '',
        city: lead.city || '', website: lead.website || '',
        sequence_stage: 0, sequence_stopped: 0, last_email_sent: null,
        status: 'New', revenue_onetime: 0, revenue_recurring: 0,
        notes: notesParts.join(' · '),
        ab_variant: '', opened: 0, replied: 0,
        reply_sentiment: '', lead_id: lead.id,
        created_at: new Date().toISOString()
      });
    }
  } catch (crmErr) { console.error('[CRM] Targeted sync error:', crmErr.message); }

  currentStats.phase = 'queued';

  const campaign = { id:campaignId, startedAt, completedAt:new Date().toISOString(), status:botAborted?'aborted':'queued', stats:{...currentStats} };
  const camps = readJ(CAMPS_FILE);
  camps.unshift(campaign);
  writeJ(CAMPS_FILE, camps);
  botRunning = false;

  broadcast({ type:'bot_complete', message:`Done! ${currentStats.queued} leads queued from ${city}. ${cronRunning ? 'Auto-send is active.' : 'Press "Start Auto-Send" to begin sending.'}`, stats:currentStats, campaign, queueLeft:queueLength() });
}

// ── SECTOR PRESETS API ─────────────────────────────────────────
app.get('/outreachbot/api/sector-presets', (req, res) => {
  res.json(Object.entries(SECTOR_PRESETS).map(([key, sectors]) => ({ key, label: key.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()), sectors })));
});

// ── TARGETED BOT START API ────────────────────────────────────
app.post('/outreachbot/api/bot/targeted', (req, res) => {
  if (botRunning) return res.status(409).json({ error:'already running' });
  const { city, sectorKeys, noWebsiteOnly, validateEmails, targetCount } = req.body || {};
  if (!city) return res.status(400).json({ error:'city is required' });
  if (!CITY_MAP[city]) return res.status(400).json({ error:`Unknown city: ${city}` });
  res.json({ started:true, city, sectorKeys, noWebsiteOnly, validateEmails, targetCount });
  runTargetedBot({
    city,
    sectorKeys:    Array.isArray(sectorKeys) ? sectorKeys : [],
    noWebsiteOnly: !!noWebsiteOnly,
    validateEmails: !!validateEmails,
    targetCount:   Math.min(parseInt(targetCount || 1000), 1000),
  }).catch(err => { botRunning = false; broadcast({ type:'bot_error', message:err.message }); });
});

// ── ACCOUNTS API ──────────────────────────────────────────────
app.get('/outreachbot/api/accounts', (req, res) => {
  const pool = getAccountPool();
  res.json(pool.map(a => ({
    user: a.user,
    selected: senderMode === 'specific' && selectedAccountUser === a.user,
    sentToday: getSentCountToday(a.user),
    dailyCap: PER_ACCOUNT_DAILY_CAP,
    capped: isAccountCapped(a.user),
    ...getHealth(a.user)
  })));
});

app.post('/outreachbot/api/accounts/test', async (req, res) => {
  const pool = getAccountPool();
  if (!pool.length) return res.json({ results:[], error:'No SMTP accounts configured.' });
  const results = await Promise.all(pool.map(async account => {
    try {
      const t = getTransporter(account);
      await t.verify();
      markAccountOk(account.user);
      return { user: account.user, status: 'ok' };
    } catch (err) {
      markAccountError(account.user, err.message);
      return { user: account.user, status: 'error', error: err.message };
    }
  }));
  if (results.some(r => r.status === 'ok')) {
    totalSentToday = 0;
  }
  res.json({ results });
});

app.post('/outreachbot/api/config/sender', (req, res) => {
  const { mode, account } = req.body;
  if (mode === 'rotation') { senderMode = 'rotation'; selectedAccountUser = null; }
  else if (mode === 'specific' && account) { senderMode = 'specific'; selectedAccountUser = account; }
  res.json({ senderMode, selectedAccountUser });
});

// ── SSE ───────────────────────────────────────────────────────
app.get('/outreachbot/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.push(res);
  const pool = getAccountPool();
  res.write(`data: ${JSON.stringify({ type:'connected', stats:currentStats, running:botRunning, cronRunning, accountCount:pool.length, queueLeft:queueLength() })}\n\n`);
  const hb = setInterval(() => { try { res.write('data: {"type":"ping"}\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); sseClients = sseClients.filter(c => c !== res); });
});

// ── API ────────────────────────────────────────────────────────
app.post('/outreachbot/api/bot/start', (req, res) => {
  if (botRunning) return res.status(409).json({ error:'already running' });
  res.json({ started:true });
  runBot().catch(err => { botRunning = false; broadcast({ type:'bot_error', message:err.message }); });
});

app.post('/outreachbot/api/bot/stop', (req, res) => {
  botAborted = true; res.json({ stopped:true });
  broadcast({ type:'bot_stopped', message:'Search stopped by user.' });
});

app.post('/outreachbot/api/cron/start', (req, res) => {
  const ok = startCronScheduler();
  res.json({ ok, cronRunning });
});

app.post('/outreachbot/api/cron/stop', (req, res) => {
  stopCronScheduler(); res.json({ stopped:true });
});

// ── AI STATUS ─────────────────────────────────────────────────
app.get('/outreachbot/api/ai/status', (req, res) => {
  res.json({
    aiActive: !!process.env.GEMINI_API_KEY,
    aiGeneratedCount: currentStats.aiGenerated || 0,
    model: 'gemini-2.0-flash'
  });
});

// ── FAILED LEADS ──────────────────────────────────────────────
app.get('/outreachbot/api/failed-leads', (req, res) => {
  res.json(readJ(FAILED_LEADS_FILE));
});

app.delete('/outreachbot/api/failed-leads', (req, res) => {
  // Purge failed leads from queue + leads file so they're never retried
  const failed = readJ(FAILED_LEADS_FILE);
  const failedIds = new Set(failed.map(f => f.id).filter(Boolean));
  const failedEmails = new Set(failed.map(f => f.email).filter(Boolean));
  const q = getQueue().filter(i => !failedIds.has(i.id) && !failedEmails.has(i.email));
  writeQueue(q);
  const leads = readJ(LEADS_FILE);
  leads.forEach(l => {
    if (failedIds.has(l.id) || failedEmails.has(l.email)) l.emailStatus = 'Bounced: removed';
  });
  writeJ(LEADS_FILE, leads);
  res.json({ purged: failed.length });
});

// ── BOUNCE STATUS ─────────────────────────────────────────────
app.get('/outreachbot/api/bounce/status', (req, res) => {
  res.json({
    consecutiveBounces,
    inCooldown: isInBounceCooldown(),
    cooldownUntil: bounceCooldownUntil,
    failedCount: readJ(FAILED_LEADS_FILE).length
  });
});

// ── AI AUDIT & SEND (first N leads) ──────────────────────────
let aiAuditRunning = false;
app.post('/outreachbot/api/ai-audit', async (req, res) => {
  if (aiAuditRunning) return res.status(409).json({ error: 'AI audit already running' });
  if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY not configured' });

  const limit  = Math.min(parseInt(req.body?.limit || '50'), 200);
  const sender = process.env.SENDER_NAME || 'SA';
  const pool   = getAccountPool();
  if (!pool.length) return res.status(400).json({ error: 'No SMTP accounts configured' });

  res.json({ started: true, limit });
  aiAuditRunning = true;

  broadcast({ type: 'ai_audit_start', message: `🤖 AI Audit started — processing up to ${limit} leads...`, limit });

  try {
    const queue = getQueue();
    const pending = queue.filter(i => !i.sent && !i.failed).slice(0, limit);

    if (!pending.length) {
      broadcast({ type: 'ai_audit_done', message: '⚠ No pending leads in queue to process.', processed: 0 });
      aiAuditRunning = false;
      return;
    }

    let processed = 0, sent = 0, failed = 0;

    for (const item of pending) {
      if (botAborted) break;

      // Re-audit website if needed
      let audit = item.audit || {};
      if (item.hasWebsite && item.website && !auditFinished(audit)) {
        broadcast({ type: 'auditing', message: `🔍 Auditing ${item.company}...`, lead: item.company });
        try {
          const freshAudit = await analyzeWebsite(item.website);
          audit = { score: freshAudit.score, ssl: freshAudit.ssl, speedMs: freshAudit.speedMs, underConstruction: freshAudit.underConstruction, noMobile: freshAudit.noMobile, issues: freshAudit.issues, estimatedLoss: freshAudit.estimatedLoss || 0 };
          if (!item.email && freshAudit.email) item.email = freshAudit.email;
          // Update queue item audit
          const q2 = getQueue();
          const qi = q2.find(x => x.id === item.id);
          if (qi) { qi.audit = audit; if (!qi.email && item.email) qi.email = item.email; writeQueue(q2); }
          currentStats.audited = (currentStats.audited || 0) + 1;
          broadcast({ type: 'audit_done', message: `${item.company}: ${audit.score}/100 · $${(audit.estimatedLoss||0).toLocaleString()}/mo loss`, lead: item.company, score: audit.score, estimatedLoss: audit.estimatedLoss || 0, stats: currentStats });
        } catch { /* keep going */ }
      }

      // ── Bounce cooldown check ──
      if (isInBounceCooldown()) {
        const resumeAt = new Date(bounceCooldownUntil).toLocaleTimeString();
        broadcast({ type: 'bounce_cooldown', message: `🛑 Bounce cooldown active — resuming at ${resumeAt}. Stopping AI Audit.` });
        break;
      }

      const emailTo = item.email || (item.hasWebsite && item.website ? `info@${getDomain(item.website)}` : null);
      if (!emailTo || !isValidEmail(emailTo)) {
        markQueueItem(item.id, { failed: true });
        logFailedLead(item, 'Invalid or missing email', emailTo);
        broadcast({ type: 'email_skip', message: `⚠ ${item.company}: skipped — invalid email (${emailTo||'none'})`, lead: item.company, queueLeft: queueLength() });
        failed++; processed++; continue;
      }

      broadcast({ type: 'ai_generating', message: `🤖 Writing AI email for ${item.company}...`, lead: item.company });
      const tmpl  = await generateEmailTemplate(item, sender, audit);
      const aiTag = tmpl.aiGenerated ? ' [AI]' : '';
      const account = getAccountForSend(pool);

      let sendOk = false;
      let lastSendErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const t = getTransporter(account);
          await t.sendMail({ from: { name: process.env.SENDER_NAME || 'SA', address: account.user }, to: emailTo, subject: tmpl.subject, text: tmpl.body });
          sendOk = true;
          break;
        } catch (err) {
          lastSendErr = err;
          if (isAuthError(err)) { markAccountError(account.user, smtpErrorMessage(err)); break; }
          if (attempt < 3) await sleep(2000 * attempt);
        }
      }

      if (sendOk) {
        recordSuccess();
        markAccountOk(account.user);
        markQueueItem(item.id, { sent: true, email: emailTo, accountUsed: account.user });
        currentStats.sent++;
        if (tmpl.aiGenerated) currentStats.aiGenerated = (currentStats.aiGenerated || 0) + 1;
        totalSentToday++;
        const leads = readJ(LEADS_FILE);
        const idx = leads.findIndex(l => l.id === item.id);
        if (idx !== -1) { leads[idx].emailSent = true; leads[idx].emailStatus = `Sent: AI Pitch${aiTag}`; leads[idx].sentAt = new Date().toISOString(); leads[idx].email = emailTo; leads[idx].accountUsed = account.user; leads[idx].aiGenerated = !!tmpl.aiGenerated; writeJ(LEADS_FILE, leads); }
        const domain = getDomain(item.website);
        if (domain) { const domains = readJ(DOMAINS_FILE); if (!domains.includes(domain)) { domains.push(domain); writeJ(DOMAINS_FILE, domains); } }
        broadcast({ type: 'email_sent', message: `✅ Sent${aiTag}: ${item.company} (${item.city})`, lead: item.company, city: item.city, email: emailTo, account: account.user, score: audit.score, queueLeft: queueLength(), stats: currentStats, aiGenerated: !!tmpl.aiGenerated });
        sent++;
      } else {
        const errMsg = smtpErrorMessage(lastSendErr);
        const isBounce = isBounceError(lastSendErr);
        markQueueItem(item.id, { failed: true });
        logFailedLead(item, isBounce ? 'Bounce: address not found' : errMsg, emailTo);
        currentStats.skipped++;
        if (isBounce) recordBounce(item.company, emailTo, errMsg.slice(0, 80));
        broadcast({ type: 'email_error', message: `✕ ${item.company}: ${isBounce ? 'Bounce — address not found' : 'send failed'}`, lead: item.company, queueLeft: queueLength() });
        failed++;
      }

      processed++;
      broadcast({ type: 'ai_audit_progress', processed, total: pending.length, sent, failed, stats: currentStats });
      // Small delay between sends to avoid rate limits
      await sleep(1500);
    }

    broadcast({ type: 'ai_audit_done', message: `🎉 AI Audit complete — ${sent} sent, ${failed} failed out of ${processed} processed`, processed, sent, failed, stats: currentStats });
  } catch (err) {
    broadcast({ type: 'ai_audit_error', message: `AI Audit error: ${err.message}` });
  } finally {
    aiAuditRunning = false;
  }
});

app.get('/outreachbot/api/bot/status', (req, res) => {
  const leads = readJ(LEADS_FILE);
  const pool  = getAccountPool();
  const memStats = crmDb.getNewNoWebsiteCount();
  res.json({ running:botRunning, aborted:botAborted, cronRunning, accountCount:pool.length, queueLeft:queueLength(), stats:currentStats, leadsCount:leads.length, sentCount:leads.filter(l=>l.emailSent).length, totalSentToday, aiActive: !!process.env.GEMINI_API_KEY, aiGeneratedCount: currentStats.aiGenerated || 0, aiAuditRunning, memoryStats: { newNoWebsite: memStats.n || 0 } });
});

app.get('/outreachbot/api/config', (req, res) => {
  const pool = getAccountPool();
  res.json({
    accountCount: pool.length,
    accounts: pool.map(a => ({ user:a.user, ...getHealth(a.user), selected: senderMode==='specific' && selectedAccountUser===a.user })),
    schedule: process.env.CRON_SCHEDULE || '*/2 * * * *',
    dailyCap: parseInt(process.env.DAILY_EMAIL_CAP || '200'),
    delayMinMs: parseInt(process.env.EMAIL_DELAY_MIN_MS || '120000'),
    delayMaxMs: parseInt(process.env.EMAIL_DELAY_MAX_MS || '300000'),
    cronRunning, queueLeft: queueLength(), totalSentToday,
    senderMode, selectedAccountUser
  });
});

app.get('/outreachbot/api/queue', (req, res) => {
  const q = getQueue();
  res.json({ total:q.length, pending:q.filter(i=>!i.sent&&!i.failed).length, sent:q.filter(i=>i.sent).length, failed:q.filter(i=>i.failed).length });
});

app.delete('/outreachbot/api/queue', (req, res) => {
  writeJ(QUEUE_FILE, []); res.json({ cleared:true });
});

app.get('/outreachbot/api/leads', (req, res) => {
  let leads = readJ(LEADS_FILE);
  const { filter, sort } = req.query;
  if (filter === 'has_website') leads = leads.filter(l => l.hasWebsite);
  if (filter === 'no_website')  leads = leads.filter(l => !l.hasWebsite);
  if (filter === 'sent')        leads = leads.filter(l => l.emailSent);
  if (filter === 'review')      leads = leads.filter(l => l.reviewRequired && !l.skippedLowLoss);
  if (filter === 'skipped')     leads = leads.filter(l => l.skippedLowLoss || (l.emailStatus && l.emailStatus.includes('Low Loss')));
  if (sort === 'score')  leads.sort((a,b) => (a.score||100) - (b.score||100));
  if (sort === 'rating') leads.sort((a,b) => (b.rating||0)  - (a.rating||0));
  if (sort === 'recent') leads.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(leads);
});

app.get('/outreachbot/api/campaigns', (req, res) => res.json(readJ(CAMPS_FILE)));

app.get('/outreachbot/api/memory', (req, res) => {
  const { filter } = req.query;
  let memory = crmDb.getAllMemory();
  if (filter === 'new') memory = memory.filter(m => m.status === 'new');
  if (filter === 'contacted') memory = memory.filter(m => m.status === 'contacted');
  if (filter === 'no_website') memory = memory.filter(m => m.has_website === 0);
  res.json(memory);
});

app.get('/outreachbot/api/memory/stats', (req, res) => {
  res.json(crmDb.getNewNoWebsiteCount());
});

app.delete('/outreachbot/api/memory', (req, res) => {
  try { crmDb.db.prepare('DELETE FROM contact_memory WHERE status = ?').run('new'); } catch {}
  res.json({ cleared: true });
});

app.delete('/outreachbot/api/leads', (req, res) => {
  if (botRunning) return res.status(409).json({ error:'Cannot clear while running' });
  writeJ(LEADS_FILE, []); writeJ(QUEUE_FILE, []); writeJ(DOMAINS_FILE, []);
  res.json({ cleared:true });
});

app.get('/outreachbot/api/export', (req, res) => {
  const leads = readJ(LEADS_FILE);
  const header = 'Company,City,Sector,Phone,Website,Email,Score,EstLossPerMonth,SSL,SpeedMs,Issues,Rating,EmailSent,SentAt,AccountUsed,CreatedAt';
  const rows = leads.map(l => {
    const a = l.audit || {};
    return [l.company,l.city,l.sector,l.phone,l.website,l.email,l.score||'',
      l.estimatedLoss||0,
      a.ssl!=null?(a.ssl?'yes':'no'):'',a.speedMs||'',(a.issues||[]).join('; '),
      l.rating,l.emailSent,l.sentAt||'',l.accountUsed||'',l.createdAt]
      .map(v=>`"${String(v||'').replace(/"/g,'""')}"`)
      .join(',');
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="leads_${Date.now()}.csv"`);
  res.send([header,...rows].join('\n'));
});

app.get('/outreachbot/health', (req, res) => {
  const leads = readJ(LEADS_FILE);
  res.json({ status:'ok', running:botRunning, cronRunning, leadsCount:leads.length, sentCount:leads.filter(l=>l.emailSent).length, queueLeft:queueLength(), uptime:process.uptime() });
});

// ── SETTINGS API ─────────────────────────────────────────────
app.get('/outreachbot/api/settings', adminAuthMiddleware, (req, res) => {
  const fileVars = parseEnvFile(readEnvFile());
  const result = {};
  SETTINGS_KEYS.forEach(k => {
    const val = fileVars[k] !== undefined ? fileVars[k] : (process.env[k] || '');
    if (val !== '') {
      result[k] = { value: val, sensitive: SENSITIVE_KEYS.has(k) };
    }
  });
  // Always include SMTP_USER / SMTP_PASS if set in process.env (from Replit secrets)
  ['SMTP_USER','SMTP_PASS',...Array.from({length:10},(_,i)=>[`SMTP_USER_${i+1}`,`SMTP_PASS_${i+1}`]).flat()].forEach(k => {
    if (process.env[k] && !result[k]) {
      result[k] = { value: process.env[k], sensitive: SENSITIVE_KEYS.has(k) };
    }
  });
  res.json(result);
});

app.post('/outreachbot/api/settings', adminAuthMiddleware, (req, res) => {
  const { vars: newVars } = req.body;
  if (!newVars || typeof newVars !== 'object') return res.status(400).json({ error: 'Invalid payload' });
  const existing = parseEnvFile(readEnvFile());
  const merged = { ...existing };
  Object.entries(newVars).forEach(([k, v]) => {
    if (v === null || v === '') delete merged[k];
    else merged[k] = String(v);
  });
  writeEnvFile(merged);
  applyEnvVars(newVars);
  // Restart cron scheduler if SMTP accounts changed
  const smtpChanged = Object.keys(newVars).some(k => k.startsWith('SMTP_'));
  if (smtpChanged) {
    accountIdx = 0;
    if (cronRunning && cronJob) { try { cronJob.stop(); } catch {} cronRunning = false; }
    setTimeout(() => { startCronScheduler(); }, 800);
  }
  broadcast({ type:'settings_saved', message:'Settings saved and applied ✓' });
  res.json({ saved: true, reloaded: true, smtpRestarted: smtpChanged });
});

app.get('/outreachbot/api/settings/verify', (req, res) => {
  const adminPass = process.env.ADMIN_PASSWORD || 'sa2024';
  const token = req.headers['x-admin-token'] || req.query.token || '';
  res.json({ ok: token === adminPass });
});

app.get('/outreachbot/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

app.get('/outreachbot/',  (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/outreachbot',   (req, res) => res.redirect('/outreachbot/'));

// ── NEW API ROUTES ────────────────────────────────────────────
registerApiRoutes(app, { getAccountPool, broadcast, adminAuthMiddleware });

// ── SEQUENCE FOLLOW-UP SCHEDULER (every 30 min) ───────────────
cron.schedule('*/30 * * * *', async () => {
  const seqSettings = {
    senderName:     process.env.SENDER_NAME      || 'SA',
    pricingWebsite: process.env.PRICING_WEBSITE  || '$1,000',
    pricingMonthly: process.env.PRICING_MONTHLY  || '$300',
    calendlyLink:   process.env.CALENDLY_LINK    || '',
    seqDays1to2:    parseInt(process.env.SEQ_DAYS_1_TO_2 || '3'),
    seqDays2to3:    parseInt(process.env.SEQ_DAYS_2_TO_3 || '4'),
  };
  try { await runSequenceFollowUps(getAccountPool, broadcast, seqSettings); }
  catch(e) { console.error('[Sequence] Scheduler error:', e.message); }
});

// ── REPLY DETECTOR (every 30 min, offset 15 min) ─────────────
cron.schedule('15,45 * * * *', async () => {
  try { await checkReplies(getAccountPool, broadcast); }
  catch(e) { console.error('[Reply] Detector error:', e.message); }
});

const PORT = process.env.PORT || 24771;
app.listen(PORT, () => {
  console.log(`OutreachBot Pro on :${PORT}`);
  // Auto-start cron scheduler on server startup
  const pool = getAccountPool();
  if (pool.length > 0) {
    broadcast({ type:'startup', message:'Server started — Auto-send will activate in 3 seconds...' });
    setTimeout(() => {
      startCronScheduler();
    }, 3000);
  } else {
    broadcast({ type:'startup_warning', message:'Server started but no SMTP accounts configured. Please set SMTP_USER and SMTP_PASS.' });
  }
});
