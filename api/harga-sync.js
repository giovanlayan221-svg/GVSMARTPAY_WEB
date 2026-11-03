// /api/harga-sync.js — dipanggil terjadwal (tiap 5 jam) untuk menyamakan harga jual dengan modal HAYBI.
// Wajib header:  Authorization: Bearer <CRON_SECRET>   (Vercel Cron mengirimnya otomatis bila CRON_SECRET diisi)
// Hanya berjalan bila admin sudah mengaktifkan "Harga otomatis" (settings/autoprice.enabled = true).
const admin = require('firebase-admin');
const crypto = require('crypto');
const { run } = require('./_hargasync');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const INTERVAL = 5 * 3600 * 1000; // harga disamakan paling sering tiap 5 jam

// Mode "tick" (tanpa rahasia): dipanggil aplikasi yang sedang dipakai. Server sendiri yang membatasi:
// hanya jalan kalau Harga otomatis AKTIF dan sinkron terakhir sudah >5 jam; kunci transaksi mencegah dua proses sekaligus.
// Jadi tidak perlu layanan cron luar, dan memanggilnya berkali-kali tidak menambah beban ke reseller.
async function tick(res) {
  if (initErr) return res.status(200).json({ ok: true, skipped: 'Server belum siap' });
  const db = admin.firestore(), ref = db.doc('settings/autoprice'), now = Date.now();
  let go = false;
  try {
    go = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref), d = s.exists ? s.data() : {};
      if (!d.enabled) return false;
      if (now - Math.max(Number(d.lastRun) || 0, Number(d.lockAt) || 0) < INTERVAL) return false;
      tx.set(ref, { lockAt: now }, { merge: true });
      return true;
    });
  } catch (e) { return res.status(200).json({ ok: true, skipped: 'sibuk' }); }
  if (!go) return res.status(200).json({ ok: true, skipped: 'belum waktunya / nonaktif' });
  try {
    const r = await run(db, { dry: false });
    return res.status(200).json({ ok: true, ran: true, stats: r.stats });
  } catch (e) {
    console.error('harga-sync tick', e.message);
    // gagal: coba lagi sekitar 15 menit kemudian, bukan menunggu 5 jam
    try { await ref.set({ lastError: String(e.message).slice(0, 200), lastErrorAt: Date.now(), lockAt: Date.now() - INTERVAL + 15 * 60 * 1000 }, { merge: true }); } catch (x) {}
    return res.status(200).json({ ok: false, error: 'sinkron gagal' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.query && req.query.tick) return tick(res);
  const sec = process.env.CRON_SECRET;
  if (!sec || sec.length < 16) return res.status(500).json({ error: 'CRON_SECRET belum diisi (min. 16 karakter)' });
  if (!same(req.headers.authorization || '', 'Bearer ' + sec)) return res.status(401).json({ error: 'Tidak diizinkan' });
  if (initErr) return res.status(500).json({ error: 'Server belum siap (Firebase)' });
  try {
    const db = admin.firestore(), st = await db.doc('settings/autoprice').get();
    if (!(st.exists && st.data().enabled)) return res.status(200).json({ ok: true, skipped: 'Harga otomatis nonaktif' });
    const r = await run(db, { dry: false });
    return res.status(200).json({ ok: true, stats: r.stats });
  } catch (e) {
    console.error('harga-sync', e.message);
    try { await admin.firestore().doc('settings/autoprice').set({ lastRun: Date.now(), lastError: String(e.message).slice(0, 200) }, { merge: true }); } catch (x) {}
    return res.status(500).json({ error: String(e.message).slice(0, 200) });
  }
};
