// /api/reseller-callback.js — dipanggil reseller (VIP Reseller / Haybi) saat status pesanan berubah.
// Body JSON: { orderId, status: 'proses'|'berhasil'|'gagal', sn?, message? }
// Keamanan: header "x-webhook-secret" harus sama dengan env RESELLER_WEBHOOK_SECRET (atau ?secret=...).
// Sesuaikan pemetaan nama field/status dengan dokumentasi reseller yang kamu pakai.
const admin = require('firebase-admin');
const { sendPush } = require('./_push');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const MAP = { proses: 'pending', pending: 'pending', processing: 'pending', berhasil: 'berhasil', success: 'berhasil', sukses: 'berhasil', gagal: 'gagal', failed: 'gagal', error: 'gagal' };
const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const sec = process.env.RESELLER_WEBHOOK_SECRET;
  if (!sec || (req.headers['x-webhook-secret'] || req.query.secret) !== sec) return res.status(401).json({ error: 'Secret salah' });
  const b = req.body || {}, st = MAP[String(b.status || '').toLowerCase()];
  if (!b.orderId || !st) return res.status(400).json({ error: 'orderId/status tidak valid' });
  const db = admin.firestore();
  let info = null;
  try {
    await db.runTransaction(async (tx) => {
      const or = db.collection('orders').doc(b.orderId), o = await tx.get(or);
      if (!o.exists) throw new Error('Pesanan tidak ditemukan');
      const x = o.data();
      if (x.status === st || x.status === 'gagal' || x.status === 'berhasil') return; // idempotent, status akhir tidak diubah
      let ur = null, u = null;
      if (st === 'gagal') { ur = db.collection('users').doc(x.uid); u = await tx.get(ur); }
      if (u && u.exists) tx.update(ur, { balance: (u.data().balance || 0) + x.total }); // refund otomatis
      tx.update(or, { status: st, sn: b.sn || null, resellerMsg: b.message || null, updatedAt: Date.now() });
      info = { uid: x.uid, name: x.name, total: x.total };
    });
    if (!info) return res.status(200).json({ ok: true, skipped: true });
    const T = { pending: ['Pesanan diproses', `${info.name} · ${rp(info.total)} sedang diproses.`], berhasil: ['Pesanan berhasil', `${info.name} · ${rp(info.total)} telah selesai diproses.` + (b.sn ? ' SN: ' + b.sn : '')], gagal: ['Pesanan gagal & saldo dikembalikan', `${info.name} · ${rp(info.total)} dibatalkan, saldo sudah dikembalikan.`] }[st];
    if (st === 'berhasil') { try { const R = require('./reward'); await R.processOrder(b.orderId, await R.cfg()); await R.flush(); } catch (e) { console.warn('reward', e.message); } } // poin, balapan, referral
    await db.collection('notifications').add({ uid: info.uid, type: 'order', title: T[0], body: T[1], read: false, createdAt: Date.now() });
    return res.status(200).json({ ok: true, push: await sendPush(db, info.uid, T[0], T[1], { tag: 'order-' + b.orderId, idem: 'order-' + b.orderId + '-' + st, event: 'order:' + st, url: '/?go=riw' }) });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
};
