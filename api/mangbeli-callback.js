// /api/mangbeli-callback.js — webhook MangBeli (POST). Daftarkan URL ini di MangBeli > Bisnis & Referral > API Saya:
//   https://<domainmu>/api/mangbeli-callback
// Keamanan: signature md5(event + data.ref_id + timestamp + MANGBELI_API_SECRET) WAJIB valid.
// Meski signature valid, status akhir TIDAK diambil dari isi webhook: pesanan dicek ulang lewat endpoint /status resmi (syncOrder),
// jadi webhook palsu/ulang/usang tidak bisa mengubah pesanan. Idempotent (1 hasil = 1 perubahan = 1 notifikasi).
const admin = require('firebase-admin');
const MB = require('./_mangbeli');
const { syncOrder } = require('./_orders');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
  if (!process.env.MANGBELI_API_SECRET) return res.status(500).json({ success: false, message: 'MANGBELI_API_SECRET belum diisi' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (!MB.verifyWebhook(b)) return res.status(401).json({ success: false, message: 'Invalid signature' });
  try {
    const ref = String((b.data && b.data.ref_id) || '');
    if (!/^MB[A-Za-z0-9]{10,40}$/.test(ref)) return res.status(200).json({ success: true, message: 'Bukan referensi GVSMARTPAY' }); // order SMM / lainnya diabaikan
    if (initErr) return res.status(500).json({ success: false, message: 'Firebase belum siap' });
    const db = admin.firestore(), orderId = ref.slice(2), s = await db.collection('orders').doc(orderId).get();
    if (!s.exists || s.data().provider !== 'mangbeli' || s.data().haybiRef !== ref) return res.status(200).json({ success: true, message: 'Pesanan tidak dikenal' });
    const r = await syncOrder(db, orderId);
    return res.status(200).json({ success: true, message: 'Processed', state: r.state });
  } catch (e) {
    console.error('mangbeli-callback', e && e.message); // jangan log body/secret
    return res.status(500).json({ success: false, message: 'Gagal memproses' }); // 5xx supaya MangBeli bisa mengulang; penyapu sync-pending menutup celah ini
  }
};
