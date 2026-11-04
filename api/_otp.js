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
