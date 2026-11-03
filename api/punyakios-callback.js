// /api/punyakios-callback.js — webhook PunyaKios (1 URL terpadu untuk semua event, sesuai dokumentasi resmi).
// Daftarkan URL ini lewat Administrator PunyaKios:  https://<domainmu>/api/punyakios-callback
// Keamanan: signature HMAC-SHA256 (header X-PunyaKios-Signature, kunci = PUNYAKIOS_API_SECRET) WAJIB valid.
// Meski signature valid, status akhir TIDAK diambil dari isi webhook: pesanan dicek ulang lewat endpoint cek status resmi (syncOrder),
// jadi webhook palsu/ulang/usang tidak bisa mengubah pesanan. Pemrosesan idempotent (1 hasil = 1 perubahan = 1 notifikasi).
const admin = require('firebase-admin');
const PK = require('./_punyakios');
const { syncOrder } = require('./_orders');
const Q = require('./pkqris');

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
  if (req.method !== 'POST') return res.status(405).json({ status: false, message: 'Method not allowed' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const event = String(b.event || '');
  if (!process.env.PUNYAKIOS_API_SECRET) return res.status(500).json({ status: false, message: 'PUNYAKIOS_API_SECRET belum diisi' });
  if (event === 'test_ping') return res.status(200).json({ status: 'ok', message: 'Ping connection verified' }); // sesuai contoh resmi: ping tidak ditandatangani/diproses
  if (!PK.verifyWebhook(req.headers['x-punyakios-signature'], b)) return res.status(401).json({ status: false, message: 'Invalid signature' });
  try {
    if (event === 'product_update') // katalog TIDAK diubah otomatis (produk lama tidak boleh terhapus/tergantikan sendiri); admin sinkron manual lewat panel PunyaKios
      return res.status(200).json({ status: 'ok', message: 'Product update acknowledged' });
    if (event === 'payment_update') { // QRIS pesanan GVSMARTPAY (external_id 'GVQ'+id). Bukti bayar tetap diambil dari cek status resmi, bukan dari isi webhook.
      const ext = String(b.external_id || '');
      if (!/^GVQ[A-Za-z0-9]{10,40}$/.test(ext)) return res.status(200).json({ status: 'ok', message: 'Ignored' });
      if (initErr) return res.status(500).json({ status: false, message: 'Firebase belum siap' });
      const r = await Q.syncIntent(admin.firestore(), ext.slice(3), { force: true });
      return res.status(200).json({ status: 'ok', message: 'Payment processed', state: r.status });
    }
    // transaction_update (atau tanpa event tapi ada ref_id)
    const ref = String(b.ref_id || '');
    if (!/^PK[A-Za-z0-9]{10,40}$/.test(ref)) return res.status(200).json({ status: 'ok', message: 'Bukan referensi GVSMARTPAY' });
    if (initErr) return res.status(500).json({ status: false, message: 'Firebase belum siap' });
    const db = admin.firestore(), orderId = ref.slice(2), s = await db.collection('orders').doc(orderId).get();
    if (!s.exists || s.data().provider !== 'punyakios' || s.data().haybiRef !== ref) return res.status(200).json({ status: 'ok', message: 'Pesanan tidak dikenal' });
    const r = await syncOrder(db, orderId);
    return res.status(200).json({ status: 'ok', message: 'Transaction processed', state: r.state });
  } catch (e) {
    console.error('punyakios-callback', e && e.message); // jangan log body/secret
    return res.status(500).json({ status: false, message: 'Gagal memproses' });                // 5xx supaya provider bisa mengulang; penyapu sync-pending juga menutup celah ini
  }
};
