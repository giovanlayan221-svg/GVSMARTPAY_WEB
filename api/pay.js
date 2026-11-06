// /api/pay.js — SEMUA yang menyentuh uang dan PIN lewat sini (Vercel Serverless + Firebase Admin).
// Browser TIDAK bisa lagi memotong saldo / membuat pesanan / mencairkan QRIS langsung ke Firestore
// (diblokir di firestore.rules.txt). Server selalu memverifikasi PIN dulu.
//   action: 'verify'  {pin}                       -> cek PIN (dipakai sebelum ubah PIN)
//           'setpin'  {pin, oldPin | reset}       -> buat / ubah PIN (reset butuh login password <5 menit lalu)
//           'order'   {pin, order:{...}}          -> buat pesanan + potong saldo PPOB
//           'wd'      {pin, amount}               -> cairkan saldo QRIS ke saldo PPOB
// Hash PIN disimpan di koleksi 'pins' (scrypt + salt acak) yang TIDAK bisa dibaca/ditulis browser.
// Salah PIN dihitung di server: 5x salah => terkunci 30 dtk, lalu 1, 2, 4, ... menit (maks 30 menit).
const admin = require('firebase-admin');
const crypto = require('crypto');
const { sendPush, sendPushWait } = require('./_push');
const V = require('./_voucher');
const FL = require('./_flash');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi di Vercel (atau belum di-Redeploy)');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const fail = (http, msg, extra) => Object.assign(new Error(msg), { http, extra: extra || {} });
