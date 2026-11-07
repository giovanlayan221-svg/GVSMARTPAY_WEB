// /api/otp.js — pendaftaran akun dengan kode OTP (anti-bot).
//   POST { action:'send',     email, hp, t }                     -> kirim kode 6 digit ke email
//   POST { action:'register', email, password, name, code, hp }  -> cek kode, lalu BUAT akun lewat server (Admin SDK)
// Akun HANYA dibuat server setelah kode benar. Supaya bot tidak bisa lompat langsung ke Firebase Auth,
// matikan pendaftaran dari klien: Firebase Console > Authentication > Settings > User actions >
// hilangkan centang "Enable create (sign-up)". (Admin SDK tetap bisa membuat akun, jadi alur ini tetap jalan.)
//
// Pengirim email (isi SALAH SATU di Vercel > Settings > Environment Variables, lalu redeploy):
//   Brevo  : BREVO_API_KEY  + OTP_FROM_EMAIL (email pengirim yang sudah diverifikasi di Brevo) [+ OTP_FROM_NAME]
//   Resend : RESEND_API_KEY + OTP_FROM_EMAIL (harus dari domain yang sudah diverifikasi di Resend) [+ OTP_FROM_NAME]
// Kode disimpan hanya sebagai hash (HMAC) di koleksi otpCodes — koleksi ini hanya diakses server.
const admin = require('firebase-admin');
const crypto = require('crypto');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const TTL = 10 * 60 * 1000;        // kode berlaku 10 menit
const COOLDOWN = 60 * 1000;        // jeda kirim ulang per email
const MAX_TRIES = 5;               // salah kode maksimal 5x, lalu kode hangus
const MAX_SEND_EMAIL = 5;          // maks kirim per email per jam
const MAX_SEND_IP = 12;            // maks kirim per IP per jam
const MIN_FILL_MS = 1500;          // form diisi < 1,5 detik = bot
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const fail = (http, msg) => Object.assign(new Error(msg), { http });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const secret = () => process.env.OTP_SECRET || process.env.FIREBASE_SERVICE_ACCOUNT || 'gv-otp';
const hmac = (email, code) => crypto.createHmac('sha256', secret()).update(email + ':' + code).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ipOf = (req) => String((req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || '')).split(',')[0].trim() || 'x';

// Pembatas per jam (pakai Firestore supaya berlaku lintas instance serverless).
async function hit(db, key, max) {
  const ref = db.doc('otpLimits/' + key), now = Date.now(), WIN = 3600 * 1000;
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref), d = s.exists ? s.data() : {};
    const start = d.start && now - d.start < WIN ? d.start : now, n = (d.start && now - d.start < WIN ? d.n : 0) + 1;
    if (n > max) return false;
    tx.set(ref, { start, n, expireAt: new Date(start + WIN * 2) });
    return true;
  });
}

async function sendMail(to, code) {
  const from = process.env.OTP_FROM_EMAIL, name = process.env.OTP_FROM_NAME || 'GVSMARTPAY';
  const subject = 'Kode verifikasi GVSMARTPAY: ' + code;
  const html = '<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px">'
    + '<h2 style="margin:0 0 8px;color:#4c1d95">GVSMARTPAY</h2><p style="color:#374151">Gunakan kode berikut untuk menyelesaikan pendaftaran:</p>'
    + '<div style="font-size:34px;letter-spacing:8px;font-weight:700;color:#7c3aed;margin:16px 0">' + code + '</div>'
    + '<p style="color:#6b7280;font-size:13px">Kode berlaku 10 menit. Jangan bagikan kode ini ke siapa pun, termasuk yang mengaku dari GVSMARTPAY. Abaikan email ini jika kamu tidak mendaftar.</p></div>';
  const text = 'Kode verifikasi GVSMARTPAY kamu: ' + code + ' (berlaku 10 menit). Jangan bagikan ke siapa pun.';
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
  try {
    let r;
    if (process.env.BREVO_API_KEY && from) {
      r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: ctl.signal, headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ sender: { name, email: from }, to: [{ email: to }], subject, htmlContent: html, textContent: text }) });
    } else if (process.env.RESEND_API_KEY && from) {
      r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: ctl.signal, headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: name + ' <' + from + '>', to: [to], subject, html, text }) });
    } else { throw fail(503, 'Layanan OTP belum diatur di server (isi BREVO_API_KEY atau RESEND_API_KEY dan OTP_FROM_EMAIL).'); }
    if (!r.ok) {
      let t = ''; try { t = (await r.text()).slice(0, 300); } catch (e) {}
      // Catatan untuk admin (lihat Vercel > Logs). 401 = API key salah / IP belum diizinkan di Brevo; 400 = pengirim (OTP_FROM_EMAIL) belum diverifikasi.
      console.error('otp-mail GAGAL status=' + r.status + ' provider=' + (process.env.BREVO_API_KEY && from ? 'brevo' : 'resend') + ' detail=' + t);
      throw fail(502, 'Email OTP gagal dikirim. Coba lagi sebentar.');
    }
  } catch (e) {
    if (e.http) throw e;
    throw fail(502, 'Email OTP gagal dikirim. Coba lagi sebentar.');
  } finally { clearTimeout(timer); }
}

// GET /api/notify?otp=1&diag=1 -> cek konfigurasi OTP TANPA mengirim email dan TANPA membuka nilai rahasia (hanya benar/salah + kode status).
async function diag(req, res) {
  const out = { ok: true, provider: process.env.BREVO_API_KEY ? 'brevo' : (process.env.RESEND_API_KEY ? 'resend' : 'none'),
    env: { BREVO_API_KEY: !!process.env.BREVO_API_KEY, RESEND_API_KEY: !!process.env.RESEND_API_KEY, OTP_FROM_EMAIL: !!process.env.OTP_FROM_EMAIL, OTP_FROM_NAME: !!process.env.OTP_FROM_NAME, OTP_SECRET: !!process.env.OTP_SECRET, FIREBASE_SERVICE_ACCOUNT: !!process.env.FIREBASE_SERVICE_ACCOUNT } };
  if (initErr) { out.ok = false; out.firebase = { ok: false, masalah: /belum diisi/.test(initErr.message) ? 'FIREBASE_SERVICE_ACCOUNT kosong' : 'FIREBASE_SERVICE_ACCOUNT bukan JSON service account yang valid' }; return res.status(200).json(out); }
  const db = admin.firestore();
  try { if (!(await hit(db, 'd_' + sha(ipOf(req)), 30))) return res.status(429).json({ error: 'Terlalu sering. Coba lagi nanti.' }); } catch (e) {}
  try { await db.doc('settings/flash').get(); out.firebase = { ok: true }; } catch (e) { out.ok = false; out.firebase = { ok: false, masalah: 'Tidak bisa membaca Firestore dengan kunci ini (' + String(e && e.code || 'error') + ')' }; }
  const key = process.env.BREVO_API_KEY, from = String(process.env.OTP_FROM_EMAIL || '').toLowerCase();
  if (key) {
    out.brevo = { kunciFormatBenar: key.startsWith('xkeysib-') };
    try {
      const r = await fetch('https://api.brevo.com/v3/senders', { headers: { 'api-key': key, accept: 'application/json' } });
      out.brevo.status = r.status;
      if (r.ok) { const j = await r.json(); const me = (j.senders || []).find((x) => String(x.email).toLowerCase() === from); out.brevo.pengirimTerdaftar = !!me; out.brevo.pengirimAktif = !!(me && me.active); if (!me || !me.active) out.ok = false; }
      else { out.ok = false; let t = ''; try { t = (await r.text()).slice(0, 200); } catch (e) {} out.brevo.pesan = t; }
    } catch (e) { out.ok = false; out.brevo.pesan = 'Tidak bisa menghubungi Brevo'; }
  } else if (!process.env.RESEND_API_KEY) { out.ok = false; out.brevo = { pesan: 'BREVO_API_KEY / RESEND_API_KEY belum diisi' }; }
  if (!process.env.OTP_FROM_EMAIL) out.ok = false;
  return res.status(200).json(out);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.query && req.query.diag) return diag(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (initErr) return res.status(500).json({ error: 'Server belum siap (Firebase)' });
  try {
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const db = admin.firestore(), email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw fail(400, 'Format email salah');
    // Jebakan bot: kolom tersembunyi harus kosong. Dibalas seolah berhasil supaya bot tidak tahu.
    if (b.hp) return res.status(200).json({ ok: true, cooldown: 60 });
    const eid = sha(email);

    if (b.action === 'send') {
      if (Number(b.t) < MIN_FILL_MS) throw fail(400, 'Terlalu cepat. Coba lagi.');
      let exists = false;
      try { await admin.auth().getUserByEmail(email); exists = true; } catch (e) { if (!(e && e.code === 'auth/user-not-found')) throw fail(500, 'Gagal memeriksa email'); }
      if (exists) throw fail(409, 'Email sudah terdaftar');
      const ref = db.doc('otpCodes/' + eid), cur = await ref.get(), now = Date.now();
      if (cur.exists && now - (cur.data().sentAt || 0) < COOLDOWN) {
        const w = Math.ceil((COOLDOWN - (now - cur.data().sentAt)) / 1000);
        return res.status(429).json({ error: 'Tunggu ' + w + ' detik sebelum kirim ulang', wait: w });
      }
      if (!(await hit(db, 'e_' + eid, MAX_SEND_EMAIL)) || !(await hit(db, 'i_' + sha(ipOf(req)), MAX_SEND_IP))) throw fail(429, 'Terlalu banyak permintaan kode. Coba lagi 1 jam lagi.');
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await sendMail(email, code); // gagal kirim = kode tidak disimpan
      await ref.set({ h: hmac(email, code), exp: now + TTL, tries: 0, sentAt: now, expireAt: new Date(now + TTL * 3) });
      return res.status(200).json({ ok: true, cooldown: 60 });
    }

    if (b.action === 'register') {
      const code = String(b.code || '').replace(/\D/g, ''), pw = String(b.password || ''), name = String(b.name || '').trim().slice(0, 60);
      if (code.length !== 6) throw fail(400, 'Masukkan 6 digit kode');
      if (pw.length < 6 || pw.length > 128) throw fail(400, 'Password minimal 6 karakter');
      if (name.length < 2) throw fail(400, 'Isi nama lengkap');
      const ref = db.doc('otpCodes/' + eid);
      // Cek + hitung percobaan dalam satu transaksi supaya tebakan paralel tidak lolos dari batas.
      const verdict = await db.runTransaction(async (tx) => {
        const s = await tx.get(ref); if (!s.exists) return 'none';
        const d = s.data();
        if (Date.now() > d.exp) { tx.delete(ref); return 'expired'; }
        if (d.tries >= MAX_TRIES) { tx.delete(ref); return 'locked'; }
        if (!same(d.h, hmac(email, code))) { tx.update(ref, { tries: d.tries + 1 }); return d.tries + 1 >= MAX_TRIES ? 'locked' : 'wrong'; }
        tx.delete(ref); return 'ok'; // kode sekali pakai
      });
      if (verdict === 'none' || verdict === 'expired') throw fail(400, 'Kode sudah kedaluwarsa. Kirim ulang kode.');
      if (verdict === 'locked') throw fail(429, 'Terlalu banyak salah. Kirim ulang kode baru.');
      if (verdict === 'wrong') throw fail(400, 'Kode salah');
      try { await admin.auth().createUser({ email, password: pw, displayName: name, emailVerified: true }); }
      catch (e) {
        if (e && e.code === 'auth/email-already-exists') throw fail(409, 'Email sudah terdaftar');
        if (e && e.code === 'auth/invalid-password') throw fail(400, 'Password minimal 6 karakter');
        console.error('otp-create', e && e.code); throw fail(500, 'Gagal membuat akun. Coba lagi.');
      }
      return res.status(200).json({ ok: true });
    }
    throw fail(400, 'action tidak dikenal');
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message });
    console.error('otp', e && e.message);
    return res.status(500).json({ error: 'Terjadi kesalahan server' });
  }
};
