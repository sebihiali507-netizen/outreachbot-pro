'use strict';
const { v4: uuid } = require('uuid');
const path = require('path');
const nodemailer = require('nodemailer');
const {
  getAllContacts, getContact, upsertContact, updateContact, deleteContact,
  searchContacts, markContactReplied, advanceSequenceStage,
  getAbResults, recordAbOpened,
  addRevenue, getRevenueSummary, getRevenueByMonth,
  getPipelineStats, insertServicesLead, getAllReplies, getSequenceLog,
  db
} = require('./db');
const { sendSequenceEmail } = require('./sequences');

module.exports = function registerRoutes(app, { getAccountPool, broadcast, adminAuthMiddleware }) {

  // ── CRM PAGE ───────────────────────────────────────────────
  app.get('/outreachbot/crm', (req, res) => res.sendFile(path.join(__dirname, 'crm.html')));
  app.get('/outreachbot/services', (req, res) => res.sendFile(path.join(__dirname, 'services.html')));

  // ── CONTACTS API ────────────────────────────────────────────
  app.get('/outreachbot/api/contacts', adminAuthMiddleware, (req, res) => {
    const { status, city, stage, q } = req.query;
    const contacts = searchContacts({ status, city, stage: stage != null ? parseInt(stage) : undefined, q });
    res.json(contacts);
  });

  app.get('/outreachbot/api/contacts/:id', adminAuthMiddleware, (req, res) => {
    const c = getContact(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  });

  app.post('/outreachbot/api/contacts', adminAuthMiddleware, (req, res) => {
    const body = req.body;
    const now = new Date().toISOString();
    const contact = {
      id: body.id || uuid(),
      company: body.company || 'Unknown',
      contact_name: body.contact_name || '',
      email: body.email || '',
      business_type: body.business_type || '',
      city: body.city || '',
      website: body.website || '',
      sequence_stage: body.sequence_stage || 0,
      sequence_stopped: body.sequence_stopped || 0,
      last_email_sent: body.last_email_sent || null,
      status: body.status || 'New',
      revenue_onetime: body.revenue_onetime || 0,
      revenue_recurring: body.revenue_recurring || 0,
      notes: body.notes || '',
      ab_variant: body.ab_variant || '',
      opened: body.opened || 0,
      replied: body.replied || 0,
      reply_sentiment: body.reply_sentiment || '',
      lead_id: body.lead_id || '',
      created_at: body.created_at || now
    };
    upsertContact(contact);
    res.json({ ok: true, id: contact.id });
  });

  app.put('/outreachbot/api/contacts/:id', adminAuthMiddleware, (req, res) => {
    const existing = getContact(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const merged = { ...existing, ...req.body, id: req.params.id };
    updateContact(merged);
    res.json({ ok: true });
  });

  app.delete('/outreachbot/api/contacts/:id', adminAuthMiddleware, (req, res) => {
    deleteContact(req.params.id);
    res.json({ ok: true });
  });

  // Bulk delete
  app.post('/outreachbot/api/contacts/bulk-delete', adminAuthMiddleware, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be array' });
    const stmt = db.prepare('DELETE FROM contacts WHERE id=?');
    const tx = db.transaction((idList) => { for (const id of idList) stmt.run(id); });
    tx(ids);
    res.json({ ok: true, deleted: ids.length });
  });

  // Bulk status update
  app.post('/outreachbot/api/contacts/bulk-status', adminAuthMiddleware, (req, res) => {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || !status) return res.status(400).json({ error: 'Invalid payload' });
    const stmt = db.prepare('UPDATE contacts SET status=? WHERE id=?');
    const tx = db.transaction((idList) => { for (const id of idList) stmt.run(status, id); });
    tx(ids);
    res.json({ ok: true, updated: ids.length });
  });

  // Contact sequence log
  app.get('/outreachbot/api/contacts/:id/log', adminAuthMiddleware, (req, res) => {
    res.json(getSequenceLog(req.params.id));
  });

  // CSV export
  app.get('/outreachbot/api/contacts/export/csv', adminAuthMiddleware, (req, res) => {
    const contacts = getAllContacts();
    const header = 'Company,ContactName,Email,BusinessType,City,Website,Stage,Status,Opened,Replied,Sentiment,RevenueOneTime,RevenueRecurring,Notes,Created';
    const rows = contacts.map(c => [
      c.company, c.contact_name, c.email, c.business_type, c.city, c.website,
      c.sequence_stage, c.status, c.opened, c.replied, c.reply_sentiment,
      c.revenue_onetime, c.revenue_recurring,
      (c.notes || '').replace(/"/g, '""'), c.created_at
    ].map(v => `"${String(v == null ? '' : v).replace(/"/g,'""')}"`).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="contacts_${Date.now()}.csv"`);
    res.send([header, ...rows].join('\n'));
  });

  // ── SEQUENCE API ────────────────────────────────────────────
  app.post('/outreachbot/api/sequence/send', adminAuthMiddleware, async (req, res) => {
    const { contactId, stage } = req.body;
    const contact = getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const pool = getAccountPool();
    if (!pool.length) return res.status(400).json({ error: 'No SMTP accounts' });
    try {
      const settings = loadSettings();
      const result = await sendSequenceEmail({ contact, stage: parseInt(stage), account: pool[0], settings });
      broadcast({ type: 'sequence_sent', message: `📧 Stage ${stage} sent to ${contact.company}`, stage, company: contact.company });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── A/B TEST API (public — no auth) ──────────────────────────
  app.get('/outreachbot/api/ab-results', (req, res) => {
    const results = getAbResults();
    // Calculate rates and winner
    let winner = null, bestScore = -1;
    const enriched = results.map(r => {
      const openRate  = r.sent > 0 ? ((r.opened  / r.sent) * 100).toFixed(1) : '0.0';
      const replyRate = r.sent > 0 ? ((r.replied / r.sent) * 100).toFixed(1) : '0.0';
      const score = r.sent >= 100 ? parseFloat(replyRate) : -1;
      if (score > bestScore) { bestScore = score; winner = r.variant; }
      return { ...r, openRate, replyRate };
    });
    const hasWinner = enriched.reduce((s, r) => s + r.sent, 0) >= 100;
    res.json({ results: enriched, winner: hasWinner ? winner : null });
  });

  // Tracking pixel for opens
  app.get('/outreachbot/track/open/:contactId', (req, res) => {
    const contact = getContact(req.params.contactId);
    if (contact) {
      recordAbOpened(contact.ab_variant || 'A');
      db.prepare('UPDATE contacts SET opened=1 WHERE id=?').run(contact.id);
    }
    // Return 1x1 transparent GIF
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(gif);
  });

  // ── REVENUE API ──────────────────────────────────────────────
  app.get('/outreachbot/api/revenue', adminAuthMiddleware, (req, res) => {
    const summary = getRevenueSummary();
    const byMonth = getRevenueByMonth();
    res.json({ summary, byMonth });
  });

  app.post('/outreachbot/api/revenue', adminAuthMiddleware, (req, res) => {
    const { contactId, type, amount, note } = req.body;
    if (!contactId || !type || !amount) return res.status(400).json({ error: 'Missing fields' });
    const contact = getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    addRevenue({ id: uuid(), contact_id: contactId, type, amount: parseFloat(amount), date: new Date().toISOString().slice(0,10), note: note||'' });
    broadcast({ type: 'revenue_added', message: `💰 Revenue added: ${type === 'one_time' ? '$'+amount+' one-time' : '$'+amount+'/mo recurring'} from ${contact.company}`, amount, company: contact.company });
    res.json({ ok: true });
  });

  // ── PIPELINE STATS API (public — no auth) ────────────────────
  app.get('/outreachbot/api/pipeline', (req, res) => {
    res.json(getPipelineStats());
  });

  // ── REPLIES API ───────────────────────────────────────────────
  app.get('/outreachbot/api/replies', adminAuthMiddleware, (req, res) => {
    res.json(getAllReplies());
  });

  // Manual reply check trigger
  app.post('/outreachbot/api/replies/check', adminAuthMiddleware, async (req, res) => {
    res.json({ started: true });
    try {
      const { checkReplies } = require('./reply-detector');
      await checkReplies(getAccountPool, broadcast);
    } catch (err) {
      broadcast({ type: 'reply_error', message: `Reply check error: ${err.message}` });
    }
  });

  // ── SERVICES LEAD FORM ────────────────────────────────────────
  app.post('/outreachbot/api/services-lead', async (req, res) => {
    const { name, email, website, message } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    insertServicesLead({ id: uuid(), name, email: email.toLowerCase(), website: website||'', message: message||'' });
    // Send admin notification
    const pool = getAccountPool();
    if (pool.length && process.env.ADMIN_EMAIL) {
      try {
        const acc = pool[0];
        const host = (process.env.SMTP_HOST || 'smtp.gmail.com').replace(/^https?:\/\//i,'').replace(/\/+$/,'');
        const port = parseInt(process.env.SMTP_PORT||'465');
        const t = nodemailer.createTransport({ host, port, secure:port===465, auth:{user:acc.user,pass:acc.pass} });
        await t.sendMail({
          from: { name:'SA OutreachBot', address: acc.user },
          to: process.env.ADMIN_EMAIL,
          subject: `🔥 New Services Lead: ${name}`,
          text: `Name: ${name}\nEmail: ${email}\nWebsite: ${website||'N/A'}\nMessage: ${message||'N/A'}`
        });
        // Auto-reply to prospect
        await t.sendMail({
          from: { name: process.env.SENDER_NAME||'SA', address: acc.user },
          to: email,
          subject: 'Got your request — we\'ll be in touch shortly',
          text: `Hi ${name},\n\nThanks for reaching out! We've received your request for a free website audit.\n\nWe'll review your site and get back to you within 24 hours with specific findings.\n\n— ${process.env.SENDER_NAME||'SA'}`
        });
      } catch (err) { console.error('[Services] Notify failed:', err.message); }
    }
    res.json({ ok: true });
  });

  // ── DASHBOARD EXTRA STATS (public) ───────────────────────────
  app.get('/outreachbot/api/dashboard', (req, res) => {
    const pipeline = getPipelineStats();
    const abResults = getAbResults();
    const revSummary = getRevenueSummary();
    const revByMonth = getRevenueByMonth();
    res.json({ pipeline, abResults, revSummary, revByMonth });
  });
};

function loadSettings() {
  return {
    senderName: process.env.SENDER_NAME || 'SA',
    pricingWebsite: process.env.PRICING_WEBSITE || '$1,000',
    pricingMonthly: process.env.PRICING_MONTHLY || '$300',
    calendlyLink: process.env.CALENDLY_LINK || '',
    seqDays1to2: process.env.SEQ_DAYS_1_TO_2 || '3',
    seqDays2to3: process.env.SEQ_DAYS_2_TO_3 || '4',
  };
}
