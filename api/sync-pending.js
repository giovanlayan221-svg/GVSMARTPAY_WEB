// /api/sync-pending.js — "penyapu" pesanan yang menggantung di status pending.
// Masalah yang diselesaikan: status pesanan hanya diperiksa (a) lewat callback HAYBI kalau sudah didaftarkan di panel HAYBI, atau
// (b) oleh aplikasi yang SEDANG TERBUKA (pengecekan di browser berhenti saat aplikasi di background/ditutup).
// Endpoint ini memeriksa pesanan pending ke HAYBI dari SERVER, sehingga notifikasi "Pesanan berhasil/gagal" tetap terkirim walau aplikasi tertutup.
// Cara pakai: jadwalkan GET/POST ke /api/sync-pending tiap 1-2 menit (cron-job.org gratis, atau Vercel Cron paket Pro)
// dengan header  Authorization: Bearer <CRON_SECRET>  (atau ?secret=<CRON_SECRET>). Env CRON_SECRET wajib diisi di Vercel.
// Aman dipanggil berulang: syncOrder idempotent (status akhir hanya ditetapkan sekali, 1 notifikasi per hasil).
const admin = require('firebase-admin');
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
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const sec = process.env.CRON_SECRET;
  if (!sec) return res.status(500).json({ error: 'CRON_SECRET belum diisi di Vercel' });
  const got = (req.headers.authorization || '').replace('Bearer ', '') || req.headers['x-cron-secret'] || (req.query && req.query.secret);
  if (got !== sec) return res.status(401).json({ error: 'Secret salah' });
  if (initErr) return res.status(500).json({ error: 'Kunci Firebase bermasalah: ' + initErr.message });
  try {
    const db = admin.firestore(), now = Date.now(), minute = Math.floor(now / 60000), T0 = now;
    // Hanya pesanan yang SUDAH terkirim ke HAYBI dan belum final. Dua filter sama-dengan: tidak butuh indeks komposit.
    const L = new Map();
    for (const st of ['pending', 'unknown']) {
      const q = await db.collection('orders').where('status', '==', 'pending').where('haybiState', '==', st).limit(40).get();
      q.docs.forEach((d) => L.set(d.id, d.data()));
    }
    const out = { found: L.size, checked: 0, finalized: 0, skipped: 0, errors: 0 };
    for (const [id, x] of L) {
      if (Date.now() - T0 > 20000) { out.skipped++; continue; }            // sisa dikerjakan putaran berikutnya
      const age = now - (x.createdAt || 0);
      if (!x.haybiRef || age > 24 * 36e5) { out.skipped++; continue; }       // lebih dari 24 jam: urusan admin
      const gap = age < 5 * 60e3 ? 1 : age < 60 * 60e3 ? 5 : 15;           // makin tua makin jarang dicek (hemat panggilan ke HAYBI)
      if (minute % gap !== 0) { out.skipped++; continue; }
      out.checked++;
      try { const r = await syncOrder(db, id); if (r.state === 'sukses' || r.state === 'berhasil' || r.state === 'gagal') out.finalized++; }
      catch (e) { out.errors++; console.warn('sync-pending', id, e && e.message); }
    }
    // QRIS yang belum terdeteksi lunas (webhook terlewat): cek ke PunyaKios. Lebih dari 24 jam = ditutup.
    out.qris = { found: 0, checked: 0 };
    const qs = await db.collection('qrisPay').where('status', '==', 'menunggu').limit(40).get();
    out.qris.found = qs.size;
    for (const d of qs.docs) {
      if (Date.now() - T0 > 24000) break;
      const age = now - (d.data().createdAt || 0);
      if (age > 24 * 36e5) { await d.ref.update({ status: 'kadaluarsa' }).catch(() => {}); continue; }
      const gap = age < 5 * 60e3 ? 1 : age < 60 * 60e3 ? 5 : 15;
      if (minute % gap !== 0) continue;
      out.qris.checked++;
      try { await Q.syncIntent(db, d.id, { force: true }); } catch (e) { console.warn('sync-qris', d.id, e && e.message); }
    }
    // Pesanan hasil QRIS yang sudah dibuat tapi BELUM terkirim ke provider (kirim gagal / terputus): coba kirim lagi (idempotent). Maks 24 jam.
    out.qrisKirim = { found: 0, retried: 0 };
    const ps = await db.collection('orders').where('status', '==', 'pending').where('payMethod', '==', 'qris').limit(40).get();
    for (const d of ps.docs) {
      const x = d.data(), age = now - (x.createdAt || 0);
      if (x.haybiRef || age > 24 * 36e5 || age < 15000) continue;
      out.qrisKirim.found++;
      if (Date.now() - T0 > 24000) break;
      out.qrisKirim.retried++; await Q.trySend(db, d.id, x.uid);
    }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) { console.error('sync-pending', e); return res.status(500).json({ error: e.message }); }
};
