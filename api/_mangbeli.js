// Klien MangBeli API v1 — HANYA dipakai di server (Vercel Serverless). Jangan di-import dari frontend.
// Dokumentasi resmi: https://mangbeli.com/api-docs  (REST + JSON, base https://mangbeli.com/api/v1)
// Konfigurasi (Vercel > Settings > Environment Variables):
//   MANGBELI_API_KEY      wajib
//   MANGBELI_API_SECRET   wajib (juga dipakai memverifikasi signature webhook)
//   MANGBELI_BASE_URL     opsional, default https://mangbeli.com/api/v1 (harus https)
// sign = md5(api_key + api_secret + suffix). Suffix per endpoint (sesuai dokumentasi):
//   pricelist -> "pricelist" | balance -> "balance" | order & status -> ref_id | price -> sku
const crypto = require('crypto');

const DEF_BASE = 'https://mangbeli.com/api/v1';
const TIMEOUT_MS = 15000;

function cfg() {
  const key = process.env.MANGBELI_API_KEY, secret = process.env.MANGBELI_API_SECRET;
  const base = String(process.env.MANGBELI_BASE_URL || DEF_BASE).trim().replace(/\/+$/, '');
  if (!key || !secret) { const e = new Error('MangBeli belum dikonfigurasi di server (MANGBELI_API_KEY / MANGBELI_API_SECRET)'); e.code = 'NOCFG'; throw e; }
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(base)) { const e = new Error('MANGBELI_BASE_URL harus diawali https://'); e.code = 'NOCFG'; throw e; }
  return { key, secret, base };
}

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

// buang api key / secret kalau (tidak sengaja) muncul di teks apa pun yang akan keluar
function scrub(v, ks) {
  let t = JSON.stringify(v === undefined ? null : v);
  for (const k of ks) if (k && String(k).length >= 4) t = t.split(String(k)).join('***');
  return JSON.parse(t);
}

const newRef = (prefix) => (prefix || 'MB') + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');

// method GET: parameter lewat query string. method POST: form-urlencoded (sesuai contoh cURL resmi).
// Return { ok, http, data }. Lempar error { code: 'NOCFG' | 'TIMEOUT' | 'NETWORK' | 'BADRESP' } kalau tidak ada jawaban JSON valid.
// HTTP non-2xx dengan body JSON dikembalikan apa adanya (ok:false) supaya pemanggil bisa membedakan penolakan dari timeout.
async function call(method, path, params, suffix) {
  const { key, secret, base } = cfg();
  const q = new URLSearchParams(Object.assign({ api_key: key }, params || {}, { sign: md5(key + secret + suffix) }));
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r, text;
  try {
    if (method === 'GET') r = await fetch(base + path + '?' + q.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: ctl.signal });
    else r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: q.toString(), signal: ctl.signal });
    text = await r.text();
  } catch (e) {
    const err = new Error(e && e.name === 'AbortError' ? 'MangBeli tidak merespons (timeout ' + TIMEOUT_MS / 1000 + ' dtk)' : 'Gagal menghubungi MangBeli');
    err.code = e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
    throw err;
  } finally { clearTimeout(timer); }
  let data;
  try { data = JSON.parse(text); } catch (e) { const err = new Error('Respons MangBeli bukan JSON (HTTP ' + r.status + ')'); err.code = 'BADRESP'; err.http = r.status; throw err; }
  return { ok: r.ok && data && data.success !== false, http: r.status, data: scrub(data, [key, secret]) };
}

// Status yang DIDOKUMENTASIKAN: pending | processing | success | failed.
// Hasil: 'sukses' | 'error' (= failed, status akhir, saldo dikembalikan otomatis oleh MangBeli) | 'pending' | 'unknown' (nilai lain: BUKAN status akhir, jangan refund, cek ulang).
const norm = (s) => {
  const v = String(s == null ? '' : s).toLowerCase();
  return v === 'success' ? 'sukses' : v === 'failed' ? 'error' : (v === 'pending' || v === 'processing') ? 'pending' : 'unknown';
};

// Webhook: signature = md5(event + data.ref_id + timestamp + api_secret) — sengaja bukan serialisasi JSON (dokumentasi resmi).
function verifyWebhook(body) {
  const secret = process.env.MANGBELI_API_SECRET;
  const b = body && typeof body === 'object' ? body : {};
  if (!secret || !b.signature || !b.event || !b.data || b.data.ref_id == null || b.timestamp == null) return false;
  const exp = Buffer.from(md5(String(b.event) + String(b.data.ref_id) + String(b.timestamp) + secret)), got = Buffer.from(String(b.signature).trim().toLowerCase());
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}

module.exports = {
  norm, newRef, verifyWebhook,
  saldo: () => call('GET', '/balance', {}, 'balance'),
  pricelist: () => call('GET', '/pricelist', {}, 'pricelist'),
  harga: (sku) => call('GET', '/price', { sku }, String(sku)),
  order: (ref, sku, customerNo) => call('POST', '/order', { sku, customer_no: customerNo, ref_id: ref }, ref),
  status: (ref) => call('GET', '/status', { ref_id: ref }, ref),
};
