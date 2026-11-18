// Customer text reminders through Twilio's REST API (no SDK needed).
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM (a number like +18455550100)
// or TWILIO_MESSAGING_SERVICE_SID.
import { TICKET_KINDS, todayYmd, addDays } from './_lib.js';

const env = () => process.env;
export const smsConfigured = () => !!(env().TWILIO_ACCOUNT_SID && env().TWILIO_AUTH_TOKEN && (env().TWILIO_FROM || env().TWILIO_MESSAGING_SERVICE_SID));

// US numbers → +1XXXXXXXXXX. Returns '' if it does not look like a phone number.
export function e164(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '';
}

const TRADE = { roof: 'roof', gutters: 'gutter', siding: 'siding' };
const niceDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }); };
export function niceTime(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  if (!m) return '';
  const h = +m[1];
  return ((h + 11) % 12) + 1 + (m[2] === '00' ? '' : ':' + m[2]) + (h < 12 ? ' AM' : ' PM');
}

export function buildMessage(template, ticket, customer, settings) {
  const today = todayYmd();
  const date = ticket.date || '';
  const when = !date ? 'soon' : date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow (' + niceDate(date) + ')' : 'on ' + niceDate(date);
  const trades = (ticket.trades || []).map((t) => TRADE[t]).filter(Boolean);
  const service = [trades.length ? trades.join(' & ') : '', (TICKET_KINDS[ticket.kind] || 'visit').toLowerCase()].filter(Boolean).join(' ');
  const name = String(customer?.name || '').trim();
  const vars = {
    first: name.split(/\s+/)[0] || 'there', name: name || 'there', when, date: date ? niceDate(date) : '',
    time: ticket.time ? ' around ' + niceTime(ticket.time) : '', service, address: ticket.address || customer?.address || 'your property',
    company_phone: settings.companyPhone || 'us',
  };
  return String(template || '').replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all)).replace(/\s+/g, ' ').trim().slice(0, 600);
}

// Returns { ok: true, sid } or { ok: false, error }.
export async function sendSms(to, body) {
  if (!smsConfigured()) return { ok: false, error: 'Texting is not set up yet.' };
  const num = e164(to);
  if (!num) return { ok: false, error: 'That phone number does not look right.' };
  const form = new URLSearchParams({ To: num, Body: body });
  if (env().TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env().TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', env().TWILIO_FROM);
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env().TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(env().TWILIO_ACCOUNT_SID + ':' + env().TWILIO_AUTH_TOKEN).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d.message || 'The text could not be sent (' + r.status + ').' };
    return { ok: true, sid: d.sid || '' };
  } catch (e) {
    return { ok: false, error: 'The texting service did not respond.' };
  }
}
