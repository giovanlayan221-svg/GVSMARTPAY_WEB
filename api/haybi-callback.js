// /api/haybi-callback.js — alamat callback untuk didaftarkan di panel HAYBI.
// Format callback HAYBI belum ada di dokumentasi, jadi payload TIDAK dipercaya: kita hanya mencari ref_id milik
// kita (awalan "GV") di payload, lalu memastikan statusnya langsung ke HAYBI lewat /cek-status.
const admin = require('firebase-admin');
const { syncOrder } = require('./_orders');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const REF = /^GV[A-Za-z0-9]{10,40}$/;
function findRefs(v, out, depth) {
  if (out.size >= 3 || depth > 4 || v == null) return;
  if (typeof v === 'string') { const t = v.trim(); if (REF.test(t)) out.add(t); else if (t[0] === '{' || t[0] === '[') { try { findRefs(JSON.parse(t), out, depth + 1); } catch (e) {} } return; }
  if (Array.isArray(v)) { v.forEach((x) => findRefs(x, out, depth + 1)); return; }
  if (typeof v === 'object') Object.values(v).forEach((x) => findRefs(x, out, depth + 1));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ ok: false });
  if (initErr) return res.status(500).json({ ok: false });
  try {
    const refs = new Set();
    findRefs(req.body, refs, 0); findRefs(req.query, refs, 0);
    const db = admin.firestore();
    for (const ref of refs) {
      const orderId = ref.slice(2), s = await db.collection('orders').doc(orderId).get();
      if (!s.exists || s.data().haybiRef !== ref) continue; // hanya pesanan kita yang benar-benar terkirim
      await syncOrder(db, orderId).catch((e) => console.warn('callback sync', e.message));
    }
    return res.status(200).json({ ok: true });
  } catch (e) { console.error('haybi-callback', e.message); return res.status(200).json({ ok: true }); }
};
