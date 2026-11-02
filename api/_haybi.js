// Klien HAYBI H2H — HANYA dipakai di server (Vercel Serverless). Jangan di-import dari frontend.
// Credential dibaca dari environment variable HAYBI_USERNAME & HAYBI_API_KEY (Vercel > Settings > Environment Variables).
const crypto = require('crypto');

const BASE = 'https://haybi.id/api/h2h';
const TIMEOUT_MS = 15000;

function creds() {
  const u = process.env.HAYBI_USERNAME, k = process.env.HAYBI_API_KEY;
  if (!u || !k) { const e = new Error('HAYBI belum dikonfigurasi di server (HAYBI_USERNAME / HAYBI_API_KEY)'); e.code = 'NOCFG'; throw e; }
  return { u, k };
}

// sign = md5(username + api_key + ref_id)
const sign = (u, k, ref) => crypto.createHash('md5').update(String(u) + String(k) + String(ref)).digest('hex');

// ref_id unik otomatis, contoh: GV-lq3k9x2a-1f9c03ab
const newRef = (prefix) => (prefix || 'GV') + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');

// buang api key jika (secara tak sengaja) muncul di teks apa pun yang akan keluar
function scrub(v, k) {
  if (!k || k.length < 4) return v;
  return JSON.parse(JSON.stringify(v).split(k).join('***'));
}

// path: 'cek-saldo' | 'cek-harga' | 'produk' | 'transaksi' | 'cek-status'
// ref: ref_id; extra: field tambahan endpoint (produk, no_tujuan, kategori, operator)
// Return: { ok, http, data }. Lempar error { code: 'NOCFG' | 'TIMEOUT' | 'NETWORK' | 'BADRESP' } kalau tidak ada jawaban valid.
async function call(path, ref, extra) {
  const { u, k } = creds();
  const body = Object.assign({ username: u, ref_id: ref, sign: sign(u, k, ref) }, extra || {});
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r, text;
  try {
    r = await fetch(BASE + '/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    text = await r.text();
  } catch (e) {
    const err = new Error(e && e.name === 'AbortError' ? 'HAYBI tidak merespons (timeout ' + TIMEOUT_MS / 1000 + ' dtk)' : 'Gagal menghubungi HAYBI');
    err.code = e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
    throw err;
  } finally { clearTimeout(timer); }
  let data;
  try { data = JSON.parse(text); } catch (e) { const err = new Error('Respons HAYBI bukan JSON (HTTP ' + r.status + ')'); err.code = 'BADRESP'; throw err; }
  return { ok: r.ok, http: r.status, data: scrub(data, k) };
}

// status HAYBI -> 'sukses' | 'pending' | 'error' | 'unknown'
const norm = (d) => { const s = String((d && d.status) || '').toLowerCase(); return s === 'sukses' || s === 'pending' || s === 'error' ? s : 'unknown'; };

module.exports = {
  newRef, norm,
  cekSaldo: () => call('cek-saldo', newRef('SLD')),
  cekHarga: (produk) => call('cek-harga', newRef('HRG'), { produk }),
  produk: (kategori, operator) => { const x = {}; if (kategori) x.kategori = kategori; if (operator) x.operator = operator; return call('produk', newRef('PRD'), x); },
  transaksi: (ref, produk, no_tujuan, extra) => call('transaksi', ref, Object.assign({ produk, no_tujuan }, extra || {})),
  cekStatus: (ref) => call('cek-status', ref),
};
