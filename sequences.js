'use strict';
const { v4: uuid } = require('uuid');
const nodemailer = require('nodemailer');
const {
  getAllContacts, advanceSequenceStage, logSequence,
  getContactsReadyForStage, recordAbSent, nextAbVariant, upsertContact
} = require('./db');

// ── EMAIL TEMPLATES ───────────────────────────────────────────
function getStage1Subject(company, variant) {
  switch (variant) {
    case 'A': return `${company} — found 3 issues costing you clients`;
    case 'B': return `Quick question about ${company}'s website`;
    case 'C': return `I built something for ${company} — free to look`;
    default:  return `${company} — found 3 issues costing you clients`;
  }
}

function buildStage1Body({ company, city, businessType, speedMs, senderName, pricingWebsite, pricingMonthly, calendlyLink }) {
  const speedSec = speedMs ? (speedMs / 1000).toFixed(1) : '4+';
  const calLink = calendlyLink ? `\n\nBook a 10-minute call here: ${calendlyLink}` : '';
  return `Hi,

I was researching ${businessType || 'local'} businesses in ${city} and audited your website.

I found 3 specific problems:

① No instant booking system
→ Clients who can't book in 60 seconds leave.

② Site loads in ${speedSec} seconds on mobile
→ Google buries slow sites. You're invisible to 70% of searches.

③ No after-hours response
→ 40% of clients reach out after 6PM. They go to whoever answers first.

Conservative estimate: you're losing $2,000–$3,500/month in missed clients right now.

I built a quick mock-up showing exactly what ${company} would look like fixed — plus an AI receptionist that books, answers, and follows up 24/7.

No cost. No commitment. Just want to show you what's possible.

Worth a 10-minute look?${calLink}

— ${senderName}`;
}

function buildStage2Body({ company, senderName, calendlyLink }) {
  const calLink = calendlyLink ? `\n\nBook here if easier: ${calendlyLink}` : '';
  return `Hi,

Just following up in case this got buried.

I finished the mock-up for ${company}.

Took me about 2 hours — figured I'd share it whether you use it or not.

If it's useful, great. If not, no worries at all.${calLink}

— ${senderName}`;
}

function buildStage3Body({ company, senderName, pricingWebsite, pricingMonthly, calendlyLink }) {
  const site = pricingWebsite || '$1,000';
  const monthly = pricingMonthly || '$300';
  const calLink = calendlyLink ? `\n\nOr book directly: ${calendlyLink}` : '';
  return `Hi,

Here's what I'm proposing:

Week 1: New professional website — live
Week 2: AI receptionist — answers, books, follows up 24/7

Investment:
→ Website: ${site} one-time
→ AI Receptionist: ${monthly}/month

If the AI closes just 2 extra clients/month at your average rate — it pays for itself in the first week.

I can start Monday.

Want to move forward?${calLink}

— ${senderName}`;
}

function getStage2Subject(company) { return `Re: ${company} — still worth sharing`; }
function getStage3Subject(company) { return `Last note — ${company}`; }

// ── SMTP TRANSPORTER ──────────────────────────────────────────
const _transporterCache = new Map();

function buildTransporter(account) {
  if (_transporterCache.has(account.user)) return _transporterCache.get(account.user);
  const host = (account.host || process.env.SMTP_HOST || 'smtp.gmail.com').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const port = parseInt(account.port || process.env.SMTP_PORT || '465');
  const t = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: account.user, pass: account.pass } });
  _transporterCache.set(account.user, t);
  return t;
}

function clearTransporterCache() { _transporterCache.clear(); }

// ── SEND SEQUENCE EMAIL ───────────────────────────────────────
async function sendSequenceEmail({ contact, stage, account, settings }) {
  const senderName = process.env.SENDER_NAME || settings.senderName || 'SA';
  const pricingWebsite = process.env.PRICING_WEBSITE || settings.pricingWebsite || '$1,000';
  const pricingMonthly = process.env.PRICING_MONTHLY || settings.pricingMonthly || '$300';
  const calendlyLink   = process.env.CALENDLY_LINK || settings.calendlyLink || '';

  const ctx = {
    company: contact.company,
    city: contact.city,
    businessType: contact.business_type,
    speedMs: null,
    senderName, pricingWebsite, pricingMonthly, calendlyLink
  };

  let subject, body;

  if (stage === 1) {
    const variant = contact.ab_variant || nextAbVariant();
    subject = getStage1Subject(contact.company, variant);
    body    = buildStage1Body(ctx);
    // Save variant on contact
    if (!contact.ab_variant) {
      require('./db').db.prepare('UPDATE contacts SET ab_variant=? WHERE id=?').run(variant, contact.id);
      contact.ab_variant = variant;
    }
    recordAbSent(variant);
  } else if (stage === 2) {
    subject = getStage2Subject(contact.company);
    body    = buildStage2Body(ctx);
  } else {
    subject = getStage3Subject(contact.company);
    body    = buildStage3Body(ctx);
  }

  const transporter = buildTransporter(account);
  await transporter.sendMail({
    from: { name: senderName, address: account.user },
    to: contact.email,
    subject,
    text: body
  });

  advanceSequenceStage(contact.id, stage);
  logSequence({
    id: uuid(),
    contact_id: contact.id,
    stage,
    sent_at: new Date().toISOString(),
    subject,
    ab_variant: contact.ab_variant || ''
  });

  return { subject, stage };
}

// ── AUTO FOLLOW-UP RUNNER ─────────────────────────────────────
async function runSequenceFollowUps(getAccountPool, broadcast, settings) {
  const stage2Days = parseInt(process.env.SEQ_DAYS_1_TO_2 || settings.seqDays1to2 || '3');
  const stage3Days = parseInt(process.env.SEQ_DAYS_2_TO_3 || settings.seqDays2to3 || '4');
  const pool = getAccountPool();
  if (!pool.length) return;

  let accountIdx = 0;
  const getAccount = () => {
    const acc = pool[accountIdx % pool.length];
    accountIdx++;
    return acc;
  };

  let sent = 0, failed = 0;

  // Stage 2 follow-ups
  const forStage2 = getContactsReadyForStage(2, stage2Days);
  for (const c of forStage2) {
    try {
      const result = await sendSequenceEmail({ contact: c, stage: 2, account: getAccount(), settings });
      broadcast({ type: 'sequence_sent', message: `📧 Stage 2 follow-up sent to ${c.company} (${c.email})`, stage: 2, company: c.company });
      sent++;
    } catch (err) {
      broadcast({ type: 'sequence_error', message: `✕ Stage 2 failed for ${c.company}: ${err.message}`, company: c.company });
      failed++;
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  // Stage 3 follow-ups
  const forStage3 = getContactsReadyForStage(3, stage3Days);
  for (const c of forStage3) {
    try {
      const result = await sendSequenceEmail({ contact: c, stage: 3, account: getAccount(), settings });
      broadcast({ type: 'sequence_sent', message: `📧 Stage 3 closing sent to ${c.company} (${c.email})`, stage: 3, company: c.company });
      sent++;
    } catch (err) {
      broadcast({ type: 'sequence_error', message: `✕ Stage 3 failed for ${c.company}: ${err.message}`, company: c.company });
      failed++;
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  if (sent > 0 || failed > 0) {
    broadcast({ type: 'sequence_summary', message: `Sequence runner: ${sent} sent, ${failed} failed`, sent, failed });
  }
  return { sent, failed };
}

module.exports = {
  sendSequenceEmail, runSequenceFollowUps,
  buildStage1Body, buildStage2Body, buildStage3Body,
  getStage1Subject, getStage2Subject, getStage3Subject,
  clearTransporterCache
};
