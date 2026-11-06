// /api/pkqris.js — bayar pesanan lewat QRIS PunyaKios (alternatif dari saldo GVSMARTPAY).
// Alur: create (QRIS dibuat, pesanan BELUM ada) -> pelanggan bayar -> webhook/cek status ("paid") -> pesanan dibuat sekali -> dikirim ke provider.
//  - Biaya QRIS dibebankan ke pelanggan (fee_charge_to: user). Pesanan gagal => saldo GVSMARTPAY pelanggan bertambah sebesar yang dibayar.
//  - Pembayaran TERLAMBAT (lewat batas 24 jam) atau produk berubah harga / nonaktif sebelum dibayar => uang masuk sebagai saldo GVSMARTPAY.
//  - Hanya status "paid" dari endpoint cek status PunyaKios yang dipercaya; isi webhook tidak dipakai sebagai bukti bayar.
//  - Idempotent: satu pembayaran = satu pesanan (ID pesanan = ID pembayaran), aman dipanggil dari webhook, penyapu, dan browser bersamaan.
const admin = require('firebase-admin');
const PK = require('./_punyakios');
const { sendPush } = require('./_push');
const FL = require('./_flash');
const PAY = require('./pay');
const V = require('./_voucher');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const WINDOW_MS = 24 * 3600e3;           // batas bayar = 24 jam (sama dengan masa berlaku QRIS di PunyaKios); kalau PunyaKios memberi expires_at lebih awal, itu yang dipakai
const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const fail = (code, msg, extra) => Object.assign(new Error(msg), { http: code }, extra || {});
