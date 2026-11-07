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
    if (!tok) return res.status(401).json({ error: 'Belum login' });
    const me = await admin.auth().verifyIdToken(tok);
    const db = admin.firestore(), FV = admin.firestore.FieldValue, ur = db.doc('users/' + me.uid);

    if (b.action === 'register' || b.action === 'unregister') {
      const t = String(b.token || '');
      if (t.length < 20 || t.length > 4096) return res.status(400).json({ error: 'Token tidak valid' });
      if (b.action === 'register') {
        await ur.update({ fcmTokens: FV.arrayUnion(t), fcmToken: t, fcmAt: Date.now() });
        // Satu token = satu akun. Kalau HP ini sebelumnya dipakai akun lain (logout tidak sempat jalan), lepaskan dari akun itu
        // supaya notifikasi akun lain tidak muncul di HP ini.
        try {
          const o1 = await db.collection('users').where('fcmTokens', 'array-contains', t).get(), o2 = await db.collection('users').where('fcmToken', '==', t).get(), seen = new Set();
          for (const d of [...o1.docs, ...o2.docs]) {
            if (d.id === me.uid || seen.has(d.id)) continue; seen.add(d.id);
            const x = d.data() || {}, u = { fcmTokens: FV.arrayRemove(t) }; if (x.fcmToken === t) u.fcmToken = null;
            await d.ref.update(u).catch(() => {});
          }
        } catch (e) { console.warn('register-dedupe', e && e.message); }
      }
      else { await ur.update({ fcmTokens: FV.arrayRemove(t) }); const u = await ur.get(); if (u.exists && u.data().fcmToken === t) await ur.update({ fcmToken: null }); }
      return res.json({ ok: true });
    }

    const meDoc = await ur.get();
    const isAdmin = meDoc.exists && meDoc.data().role === 'admin';

    if (b.action === 'test') {
      const m = await tokensFor(db, me.uid);
      const r = await sendPush(db, me.uid, 'Tes notifikasi GVSMARTPAY', 'Kalau pesan ini muncul, notifikasi di HP ini sudah beres.', { tag: 'test-' + Date.now().toString(36), url: '/' });
      return res.json({ ok: true, devices: m.size, ...r });
    }
    if (b.action === 'logs') {
      if (!isAdmin) return res.status(403).json({ error: 'Hanya admin' });
      const q = await db.collection('pushLogs').orderBy('at', 'desc').limit(25).get();
      return res.json({ ok: true, logs: q.docs.map((d) => { const x = d.data() || {}; return { id: d.id, at: x.at, target: x.target, title: x.title, event: x.event, tokens: x.tokens, sent: x.sent, failed: x.failed, dead: x.dead, retries: x.retries, shown: x.shown, state: x.state, errors: x.errors || [] }; }) });
    }
    if (b.action === 'status') {
      if (!isAdmin) return res.status(403).json({ error: 'Hanya admin' });
      const all = (await db.collection('users').get()).docs;
      const withTok = all.filter((d) => { const x = d.data() || {}; return (Array.isArray(x.fcmTokens) && x.fcmTokens.length) || x.fcmToken; }).length;
      return res.json({ ok: true, users: all.length, withToken: withTok });
    }

    const { uid, delay, url, tag, nonce } = b;
    let { title, body } = b;
    if (!uid || !title) return res.status(400).json({ error: 'uid dan title wajib diisi' });
    if (!isAdmin) { title = String(title).slice(0, 80); body = String(body || '').slice(0, 200); } // akun biasa: teks dibatasi (anti spam / penipuan ke admin)
    if (!isAdmin && uid !== 'admin' && uid !== me.uid) return res.status(403).json({ error: 'Tidak diizinkan mengirim ke pengguna lain' });
    if (!isAdmin && limited(me.uid)) return res.status(429).json({ error: 'Terlalu banyak notifikasi, coba lagi sebentar' });
    if (delay) await new Promise((r) => setTimeout(r, Math.min(Number(delay) || 0, 8) * 1000));
    // nonce dari browser dipakai sebagai kunci idempotensi: kiriman ulang karena respons hilang tidak jadi notifikasi ganda
    return res.status(200).json(await sendPush(db, uid, title, body, { url, tag, nonce, idem: nonce ? 'c-' + me.uid + '-' + String(nonce).slice(0, 40) : undefined }));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
                                                        
