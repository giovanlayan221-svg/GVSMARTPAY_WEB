// /api/notify.js — kirim push notification (Vercel Serverless, tanpa Firebase Blaze).
// Wajib login (ID token di header Authorization ATAU field idToken, supaya bisa dipakai sendBeacon).
// Admin boleh kirim ke siapa saja ('all' / uid / 'admin'); pengguna biasa hanya ke 'admin' atau dirinya sendiri.
// action: (kosong)=kirim | 'register' {token} | 'unregister' {token} | 'test' | 'status' (admin) | 'logs' (admin)
//         | 'ack' {lid,sig} = konfirmasi dari service worker bahwa notifikasi SUDAH ditampilkan (tanpa login, dijaga tanda tangan HMAC)
const admin = require('firebase-admin');
const { sendPush, tokensFor, ackSig } = require('./_push');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi di Vercel (atau belum di-Redeploy)');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const HIT = new Map(); // pembatas sederhana per akun (anti-spam notifikasi dari akun biasa)
const limited = (uid) => { const now = Date.now(), a = (HIT.get(uid) || []).filter((t) => now - t < 60000); a.push(now); HIT.set(uid, a); return a.length > 30; };

module.exports = async (req, res) => {
  // /api/otp (pendaftaran OTP) dialihkan ke sini lewat rewrite di vercel.json agar jumlah Serverless Function tetap 12 (batas akun Hobby).
  if (req.query && req.query.otp) return require('./_otp')(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (initErr) return res.status(500).json({ error: 'Kunci Firebase bermasalah: ' + initErr.message });
  try {
    res.setHeader('Cache-Control', 'no-store');
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    if (b.action === 'ack') { // dari service worker: tidak punya ID token, jadi dijaga tanda tangan yang hanya server bisa buat
      const lid = String(b.lid || '');
      if (!/^[A-Za-z0-9_.~%-]{6,140}$/.test(lid) || /^\.+$/.test(lid) || String(b.sig || '') !== ackSig(lid)) return res.status(403).json({ error: 'Tanda tangan tidak valid' });
      await admin.firestore().doc('pushLogs/' + lid).update({ shown: admin.firestore.FieldValue.increment(1), shownAt: Date.now() }).catch(() => {});
      return res.json({ ok: true });
    }
    const tok = (req.headers.authorization || '').replace('Bearer ', '') || b.idToken;
