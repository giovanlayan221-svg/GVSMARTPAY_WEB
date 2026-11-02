// Klien PunyaKios Partner H2H — HANYA dipakai di server (Vercel Serverless). Jangan di-import dari frontend.
// Dokumentasi resmi: https://punyakios.id/docs (Partner API v1.3.0). Semua endpoint: POST + JSON + header X-API-KEY / X-API-SECRET.
// Konfigurasi (Vercel > Settings > Environment Variables):
//   PUNYAKIOS_API_KEY      wajib   (contoh pk_live_xxx)
//   PUNYAKIOS_API_SECRET   wajib   (contoh ps_live_xxx) — juga dipakai memverifikasi signature webhook
//   PUNYAKIOS_BASE_URL     opsional, default https://punyakios.id/api/v1/partner (harus https)
const crypto = require('crypto');

const DEF_BASE = 'https://punyakios.id/api/v1/partner';
const TIMEOUT_MS = 15000;

function cfg() {
  const key = process.env.PUNYAKIOS_API_KEY, secret = process.env.PUNYAKIOS_API_SECRET;
  const base = String(process.env.PUNYAKIOS_BASE_URL || DEF_BASE).trim().replace(/\/+$/, '');
  if (!key || !secret) { const e = new Error('PunyaKios belum dikonfigurasi di server (PUNYAKIOS_API_KEY / PUNYAKIOS_API_SECRET)'); e.code = 'NOCFG'; throw e; }
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(base)) { const e = new Error('PUNYAKIOS_BASE_URL harus diawali https://'); e.code = 'NOCFG'; throw e; }
  return { key, secret, base };
}

// Buang API key / secret kalau (tidak sengaja) muncul di teks apa pun yang akan keluar (respons ke admin, log).
function scrub(v, ks) {
  let t = JSON.stringify(v === undefined ? null : v);
  for (const k of ks) if (k && String(k).length >= 4) t = t.split(String(k)).join('***');
  return JSON.parse(t);
}

// Return { ok, http, data }. Lempar error { code: 'NOCFG' | 'TIMEOUT' | 'NETWORK' | 'BADRESP', http? } kalau tidak ada jawaban JSON yang valid.
// HTTP non-2xx dengan body JSON dikembalikan apa adanya (ok:false) supaya pemanggil bisa membedakan penolakan dari timeout.
async function call(path, body) {
  const { key, secret, base } = cfg();
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r, text;
  try {
    r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-KEY': key, 'X-API-SECRET': secret }, body: JSON.stringify(body || {}), signal: ctl.signal });
    text = await r.text();
  } catch (e) {
    const err = new Error(e && e.name === 'AbortError' ? 'PunyaKios tidak merespons (timeout ' + TIMEOUT_MS / 1000 + ' dtk)' : 'Gagal menghubungi PunyaKios');
    err.code = e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
    throw err;
  } finally { clearTimeout(timer); }
  let data;
  try { data = JSON.parse(text); } catch (e) { const err = new Error('Respons PunyaKios bukan JSON (HTTP ' + r.status + ')'); err.code = 'BADRESP'; err.http = r.status; throw err; }
  return { ok: r.ok, http: r.status, data: scrub(data, [key, secret]) };
}

// Status transaksi yang DIDEFINISIKAN dokumentasi: success | failed | pending.
// Hasil: 'sukses' | 'error' (= failed, status akhir) | 'pending' | 'unknown' (nilai lain/kosong: BUKAN status akhir, jangan refund, cek ulang).
const norm = (s) => { const v = String(s == null ? '' : s).toLowerCase(); return v === 'success' ? 'sukses' : v === 'failed' ? 'error' : v === 'pending' ? 'pending' : 'unknown'; };

// String yang ditandatangani, persis seperti contoh handler resmi:
//   product_update : "product_update.{action}.{count}.{timestamp}"
//   transaksi      : "{ref_id atau external_id}.{status}.{amount}"
function webhookString(b) {
  b = b || {};
  if (String(b.event || '') === 'product_update') return 'product_update.' + (b.action == null ? '' : b.action) + '.' + (b.count == null ? 0 : b.count) + '.' + (b.timestamp == null ? '' : b.timestamp);
  const ref = b.ref_id != null ? b.ref_id : (b.external_id != null ? b.external_id : '');
  return ref + '.' + (b.status == null ? '' : b.status) + '.' + (b.amount == null ? '' : b.amount);
}
// HMAC-SHA256 (hex) dengan API Secret, dibandingkan konstan-waktu dengan header X-PunyaKios-Signature.
function verifyWebhook(sigHeader, body) {
  const secret = process.env.PUNYAKIOS_API_SECRET;
  if (!secret || !sigHeader) return false;
  const exp = Buffer.from(crypto.createHmac('sha256', secret).update(webhookString(body)).digest('hex')), got = Buffer.from(String(sigHeader).trim().toLowerCase());
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}

module.exports = {
  norm, verifyWebhook, webhookString,
  profile: () => call('/profile'),
  produk: (f) => { const b = { type: 'prepaid' }; if (f && f.category) b.category = f.category; if (f && f.provider) b.provider = f.provider; return call('/products', b); },
  order: (ref, sku, customerNo) => call('/prepaid/order', { ref_id: ref, sku, customer_no: customerNo }),
  status: (ref) => call('/transaction/status', { ref_id: ref }),
  // Terima pembayaran: QRIS dinamis (biaya QRIS dibebankan ke pembeli) dan cek status pembayarannya.
  payCreate: (extId, amount, description) => call('/payment-request', { external_id: extId, amount, description: String(description || '').slice(0, 200), payment_method: 'qris', fee_charge_to: 'user' }),
  payStatus: (extId) => call('/check-status', { external_id: extId }),
};
