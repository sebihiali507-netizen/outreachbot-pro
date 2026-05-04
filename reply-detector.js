'use strict';
const { ImapFlow } = require('imapflow');
const { v4: uuid } = require('uuid');
const { getAllContacts, markContactReplied, insertReply, recordAbReplied, getContact } = require('./db');
const nodemailer = require('nodemailer');

let lastCheckTime = new Date(Date.now() - 31 * 60 * 1000); // Check last 31 min on first run

// ── SENTIMENT VIA GEMINI ──────────────────────────────────────
async function analyzeSentiment(bodyText) {
  if (!process.env.GEMINI_API_KEY) return 'other';
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(
      `Analyze this email reply and classify it into exactly ONE word: "interested", "question", "not_interested", or "other".\n\nReply:\n${bodyText.slice(0, 500)}\n\nRespond with ONLY the single classification word.`
    );
    const raw = result.response.text().trim().toLowerCase().replace(/[^a-z_]/g, '');
    if (['interested','question','not_interested','other'].includes(raw)) return raw;
    return 'other';
  } catch { return 'other'; }
}

// ── ADMIN NOTIFICATION ────────────────────────────────────────
async function sendAdminNotification(contact, reply, sentiment, account) {
  if (!account || !process.env.ADMIN_EMAIL) return;
  try {
    const host = (account.host || process.env.SMTP_HOST || 'smtp.gmail.com').replace(/^https?:\/\//i, '').replace(/\/+$/,'');
    const port = parseInt(account.port || process.env.SMTP_PORT || '465');
    const t = nodemailer.createTransport({ host, port, secure: port===465, auth: { user: account.user, pass: account.pass } });
    const emoji = { interested:'🟢', question:'🟡', not_interested:'🔴', other:'⚪' }[sentiment] || '⚪';
    await t.sendMail({
      from: { name: 'SA OutreachBot', address: account.user },
      to: process.env.ADMIN_EMAIL,
      subject: `${emoji} Reply from ${contact.company} — ${sentiment.replace('_',' ')}`,
      text: `Company: ${contact.company}\nEmail: ${reply.email_from}\nSentiment: ${emoji} ${sentiment}\n\nReply preview:\n${reply.body_preview}`
    });
  } catch (err) { console.error('[Reply] Admin notify failed:', err.message); }
}

// ── IMAP CHECK ────────────────────────────────────────────────
async function checkReplies(getAccountPool, broadcast) {
  const pool = getAccountPool();
  if (!pool.length) return;

  const contacts = getAllContacts().filter(c => c.sequence_stage > 0 && !c.replied && c.email);
  if (!contacts.length) return;

  const emailToContact = new Map();
  for (const c of contacts) emailToContact.set(c.email.toLowerCase(), c);

  const since = lastCheckTime;
  lastCheckTime = new Date();

  let foundReplies = 0;

  for (const account of pool) {
    let client;
    try {
      const imapHost = (account.imapHost || process.env.IMAP_HOST || 'imap.gmail.com');
      const imapPort = parseInt(account.imapPort || process.env.IMAP_PORT || '993');
      client = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: true,
        auth: { user: account.user, pass: account.pass },
        logger: false,
        tls: { rejectUnauthorized: false }
      });

      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch(
          { since: since.toISOString() },
          { envelope: true, bodyStructure: true, bodyParts: ['TEXT'] }
        )) {
          const fromAddr = (msg.envelope.from?.[0]?.address || '').toLowerCase();
          const subject  = msg.envelope.subject || '';
          const bodyBuf  = msg.bodyParts?.get('TEXT');
          const body     = bodyBuf ? bodyBuf.toString('utf8').slice(0, 800) : '';

          // Check if this is a reply from a tracked contact
          const contact = emailToContact.get(fromAddr);
          if (!contact) continue;

          // Avoid counting initial sent email
          const isReply = subject.toLowerCase().startsWith('re:') || msg.envelope.inReplyTo;
          if (!isReply) continue;

          const sentiment = await analyzeSentiment(body);
          const replyRec = {
            id: uuid(),
            contact_id: contact.id,
            email_from: fromAddr,
            received_at: new Date().toISOString(),
            subject,
            body_preview: body.slice(0, 400),
            sentiment
          };

          insertReply(replyRec);
          markContactReplied(contact.id, sentiment);
          if (contact.ab_variant) recordAbReplied(contact.ab_variant);

          const emojiMap = { interested:'🟢', question:'🟡', not_interested:'🔴', other:'⚪' };
          broadcast({
            type: 'reply_detected',
            message: `${emojiMap[sentiment]||'⚪'} Reply from ${contact.company} — ${sentiment.replace('_',' ')}`,
            company: contact.company,
            sentiment,
            email: fromAddr
          });

          await sendAdminNotification(contact, replyRec, sentiment, pool[0]);
          foundReplies++;
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err) {
      console.error(`[Reply] IMAP check failed for ${account.user}: ${err.message}`);
      try { if (client) await client.logout(); } catch {}
    }
  }

  if (foundReplies > 0) {
    broadcast({ type: 'reply_check_done', message: `Reply check: ${foundReplies} new replies found`, count: foundReplies });
  }
  return foundReplies;
}

module.exports = { checkReplies, analyzeSentiment };
