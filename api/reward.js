// /api/reward.js — Vercel Serverless Function
// Mengurus saldo otomatis: Balapan Transaksi, komisi Referral, dan klaim Voucher.
// Memakai FIREBASE_SERVICE_ACCOUNT yang sama dengan /api/notify.js (tidak perlu paket Blaze).
const admin = require('firebase-admin');
const { sendPush } = require('./_push');
let initErr = null;
try { if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); } catch (e) { initErr = e; }
const db = admin.apps.length ? admin.firestore() : null, FV = admin.firestore.FieldValue;

const DEF = { raceMin: 50, prize1: 100000, prize2: 70000, prize3: 50000, refMin: 25, refLimit: 50, refCommission: 100 };
const pk = (t) => { const d = new Date(t + 25200000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }; // bulan WIB
const mask = (e) => { const [a, b] = String(e || '').split('@'); return a ? a[0] + '***' + a.slice(-1) + '@' + (b || '') : ''; };
const rp = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
const PEND = new Map();
const note = (tx, uid, title, body) => { PEND.set(uid + '|' + title + '|' + body, { uid, title, body }); return tx.set(db.collection('notifications').doc(), { uid, type: 'reward', title, body, read: false, createdAt: Date.now() }); };
const flush = async () => { const L = [...PEND.values()]; PEND.clear(); for (const n of L) { try { await sendPush(db, n.uid, n.title, n.body); } catch (e) { console.warn('push', e.message); } } };
const PT = (amount) => Math.floor(Number(amount || 0) / 100); // Rp1.000 = 10 poin
const RW_DEF = ['Nama lengkap', 'Nomor tujuan'];
const plog = (tx, uid, type, points, n) => tx.set(db.collection('pointLogs').doc(), { uid, type, points, note: n, createdAt: Date.now() });
const bon = (tx, uid, type, amount, n) => tx.set(db.collection('bonuses').doc(), { uid, type, amount, note: n, createdAt: Date.now() });

async function cfg() {
  const ref = db.doc('settings/rewards'), s = await ref.get(), d = s.exists ? s.data() : {};
  if (!d.startAt) { d.startAt = Date.now(); await ref.set({ startAt: d.startAt }, { merge: true }); } // order lama sebelum fitur ini tidak dihitung
  return { ...DEF, ...d };
}

async function processOrder(id, C) {
  await db.runTransaction(async (tx) => {
    const or = db.doc('orders/' + id), o = await tx.get(or);
    if (!o.exists) return;
    const x = o.data();
    if (x.status !== 'berhasil' || x.rewardDone) return;
    const at = x.updatedAt || x.createdAt || Date.now();
    if (at < C.startAt) { tx.update(or, { rewardDone: true }); return; }
    const uid = x.uid, period = pk(at);
    const sr = db.doc('userstats/' + uid), re = db.doc(`raceEntries/${period}_${uid}`), rc = db.doc('races/' + period), rf = db.doc('referrals/' + uid), ur = db.doc('users/' + uid);
    const [ss, rs, rcs, rfs, us] = await Promise.all([tx.get(sr), tx.get(re), tx.get(rc), tx.get(rf), tx.get(ur)]);
    const before = ss.exists ? ss.data().trxDone || 0 : 0, done = before + 1, R = rfs.exists ? rfs.data() : null;
    let rst = null, rank = 99, held = [];
    if (R) {
      rst = await tx.get(db.doc('userstats/' + R.referrerUid));
      const all = await tx.get(db.collection('referrals').where('referrerUid', '==', R.referrerUid));
      rank = all.docs.map((d) => d.data()).sort((a, b) => a.createdAt - b.createdAt).findIndex((d) => d.downlineUid === uid);
    }
    if (before < C.refMin && done >= C.refMin) {
      const q = await tx.get(db.collection('referrals').where('referrerUid', '==', uid));
      held = q.docs.filter((d) => (d.data().held || 0) > 0);
    }
    // ---- tulis ----
    const pts = PT(x.total);
    tx.set(sr, pts > 0 ? { trxDone: done, points: FV.increment(pts), pointsEarned: FV.increment(pts) } : { trxDone: done }, { merge: true });
    if (pts > 0) plog(tx, uid, 'in', pts, 'Transaksi ' + (x.name || 'pesanan') + ' ' + rp(x.total || 0));
    if (!rcs.exists) tx.set(rc, { period, settled: false, createdAt: Date.now() });
    const u = us.data() || {};
    tx.set(re, { period, uid, name: u.name || 'Pengguna', email: mask(u.email), count: (rs.exists ? rs.data().count || 0 : 0) + 1 }, { merge: true });
    if (held.length) {
      const total = held.reduce((a, d) => a + d.data().held, 0);
      held.forEach((d) => tx.update(d.ref, { held: 0, earned: FV.increment(d.data().held) }));
      tx.update(ur, { balance: FV.increment(total) });
      tx.set(sr, { refEarned: FV.increment(total) }, { merge: true });
      bon(tx, uid, 'Komisi referral', total, 'Syarat ' + C.refMin + ' transaksi terpenuhi');
      note(tx, uid, 'Komisi referral cair', rp(total) + ' masuk ke saldo PPOB kamu.');
    }
    if (R && rank >= 0 && rank < C.refLimit && C.refCommission > 0) {
      const c = C.refCommission, ok = rst.exists && (rst.data().trxDone || 0) >= C.refMin;
      if (ok) {
        tx.update(db.doc('users/' + R.referrerUid), { balance: FV.increment(c) });
        tx.set(db.doc('userstats/' + R.referrerUid), { refEarned: FV.increment(c) }, { merge: true });
        tx.update(rf, { trx: FV.increment(1), earned: FV.increment(c) });
        bon(tx, R.referrerUid, 'Komisi referral', c, 'Transaksi downline ' + (R.name || ''));
      } else tx.update(rf, { trx: FV.increment(1), held: FV.increment(c) });
    } else if (R) tx.update(rf, { trx: FV.increment(1) });
    tx.update(or, { rewardDone: true });
  });
}

async function settle(C) {
  const cur = pk(Date.now()), q = await db.collection('races').where('settled', '==', false).get();
  for (const d of q.docs) {
    if (d.id >= cur) continue;
    await db.runTransaction(async (tx) => {
      const rs = await tx.get(d.ref);
      if (rs.data().settled) return;
      const es = await tx.get(db.collection('raceEntries').where('period', '==', d.id));
      const top = es.docs.map((e) => e.data()).sort((a, b) => b.count - a.count).slice(0, 3), pz = [C.prize1, C.prize2, C.prize3];
      const win = top.map((t, i) => ({ uid: t.uid, rank: i + 1, count: t.count, prize: pz[i] })).filter((w) => w.count >= C.raceMin && w.prize > 0);
      win.forEach((w) => {
        tx.update(db.doc('users/' + w.uid), { balance: FV.increment(w.prize) });
        bon(tx, w.uid, 'Hadiah Balapan Transaksi', w.prize, 'Peringkat ' + w.rank + ' bulan ' + d.id);
        note(tx, w.uid, 'Selamat! Juara ' + w.rank + ' Balapan Transaksi', rp(w.prize) + ' sudah masuk ke saldo PPOB kamu.');
      });
      tx.update(d.ref, { settled: true, winners: win, settledAt: Date.now() });
    });
  }
}

// Klaim voucher PROMO: kode disimpan ke akun pengguna (voucherRedeems/{KODE}_{uid}, status 'tersedia') dan dipakai
// sebagai potongan harga saat checkout (lihat api/pay.js dan api/pkqris.js). TIDAK menambah saldo PPOB dan TIDAK memberi poin.
async function redeem(uid, raw) {
  const code = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!code) return { ok: false, msg: 'Masukkan kode voucher' };
  return db.runTransaction(async (tx) => {
    const vr = db.doc('vouchers/' + code), rr = db.doc(`voucherRedeems/${code}_${uid}`);
    const [v, r] = await Promise.all([tx.get(vr), tx.get(rr)]);
    if (!v.exists || v.data().active === false) return { ok: false, msg: 'Kode voucher tidak valid' };
    const x = v.data();
    if (x.expiresAt && x.expiresAt < Date.now()) return { ok: false, msg: 'Voucher sudah kedaluwarsa' };
    if (r.exists) return { ok: false, msg: r.data().status === 'terpakai' ? 'Kamu sudah memakai voucher ini' : 'Voucher ini sudah ada di akunmu' };
    if (x.quota && (x.used || 0) >= x.quota) return { ok: false, msg: 'Kuota voucher sudah habis' };
    // Voucher lama (dulu berupa saldo) hanya punya 'amount': dibaca sebagai potongan nominal.
    const type = x.type === 'percent' ? 'percent' : 'nominal', value = Number(x.type ? x.value : x.amount) || 0;
    if (value <= 0) return { ok: false, msg: 'Voucher ini belum diatur admin' };
    const snap = { uid, code, type, value, maxDiscount: Number(x.maxDiscount) || 0, minPurchase: Number(x.minPurchase) || 0, expiresAt: Number(x.expiresAt) || 0, status: 'tersedia', createdAt: Date.now() };
    tx.update(vr, { used: FV.increment(1) });
    tx.set(rr, snap);
    const label = type === 'percent' ? 'Diskon ' + value + '%' + (snap.maxDiscount ? ' (maks ' + rp(snap.maxDiscount) + ')' : '') : 'Potongan ' + rp(value);
    note(tx, uid, 'Voucher berhasil diklaim', label + '. Pakai saat bayar di halaman konfirmasi pembayaran.');
    return { ok: true, msg: 'Voucher berhasil diklaim: ' + label + '. Pakai saat checkout.', voucher: { id: code + '_' + uid, ...snap } };
  });
}

// Tukar poin -> hadiah. Poin dipotong di server (tidak bisa dipalsukan dari browser).
async function claim(uid, rewardId, fields) {
  return db.runTransaction(async (tx) => {
    const rr = db.doc('rewards/' + String(rewardId || '_')), sr = db.doc('userstats/' + uid), ur = db.doc('users/' + uid);
    const [r, st, u] = await Promise.all([tx.get(rr), tx.get(sr), tx.get(ur)]);
    if (!r.exists || r.data().active === false) return { ok: false, msg: 'Hadiah tidak tersedia' };
    const R = r.data(), cost = Number(R.points) || 0, have = st.exists ? st.data().points || 0 : 0;
    if (cost < 1) return { ok: false, msg: 'Hadiah tidak valid' };
    if (R.limited && (R.stock || 0) <= 0) return { ok: false, msg: 'Stok hadiah habis' };
    if (have < cost) return { ok: false, msg: 'Poin belum cukup (' + have + '/' + cost + ')' };
    const labels = Array.isArray(R.fields) && R.fields.length ? R.fields : RW_DEF, data = {};
    for (const l of labels) { const v = String((fields && fields[l]) || '').trim().slice(0, 120); if (!v) return { ok: false, msg: 'Isi ' + l }; data[l] = v; }
    tx.set(sr, { points: FV.increment(-cost), pointsSpent: FV.increment(cost) }, { merge: true });
    plog(tx, uid, 'out', cost, 'Tukar ' + R.name);
    if (R.limited) tx.update(rr, { stock: FV.increment(-1) });
    tx.set(db.collection('rewardClaims').doc(), { uid, userName: (u.data() || {}).name || 'Pengguna', rewardId: r.id, rewardName: R.name || '', points: cost, data, status: 'menunggu', createdAt: Date.now() });
    note(tx, uid, 'Penukaran poin diproses', R.name + ' · ' + cost + ' poin sedang diproses admin.');
    return { ok: true, msg: 'Penukaran dikirim, menunggu diproses admin' };
  });
}
async function claimSet(adminUid, id, status) {
  const a = await db.doc('users/' + adminUid).get();
  if (!a.exists || a.data().role !== 'admin') return { ok: false, msg: 'Khusus admin' };
  if (!['berhasil', 'ditolak'].includes(status)) return { ok: false, msg: 'Status tidak valid' };
  return db.runTransaction(async (tx) => {
    const cr = db.doc('rewardClaims/' + String(id || '_')), c = await tx.get(cr);
    if (!c.exists) return { ok: false, msg: 'Data tidak ditemukan' };
    const X = c.data();
    if (X.status !== 'menunggu') return { ok: false, msg: 'Sudah diproses' };
    let rw = null;
    if (status === 'ditolak') rw = await tx.get(db.doc('rewards/' + X.rewardId));
    tx.update(cr, { status, doneAt: Date.now() });
    if (status === 'ditolak') {
      tx.set(db.doc('userstats/' + X.uid), { points: FV.increment(X.points), pointsSpent: FV.increment(-X.points) }, { merge: true });
      plog(tx, X.uid, 'in', X.points, 'Refund penukaran ' + X.rewardName);
      if (rw.exists && rw.data().limited) tx.update(rw.ref, { stock: FV.increment(1) });
      note(tx, X.uid, 'Penukaran poin ditolak', X.rewardName + ' tidak bisa diproses. ' + X.points + ' poin sudah dikembalikan.');
    } else note(tx, X.uid, 'Hadiah berhasil dikirim', X.rewardName + ' sudah diproses sesuai data yang kamu isi.');
    return { ok: true, msg: status === 'berhasil' ? 'Ditandai selesai' : 'Ditolak, poin dikembalikan' };
  });
}

// Pencairan GVCLIPPER: pindahkan semua penghasilan video yang sudah disetujui ke saldo PPOB
async function clipWithdraw(uid) {
  const q = await db.collection('clips').where('uid', '==', uid).get();
  const list = q.docs.filter((d) => d.data().status === 'disetujui' && !d.data().paid);
  if (!list.length) return { ok: false, msg: 'Belum ada penghasilan yang siap dicairkan' };
  return db.runTransaction(async (tx) => {
    const fresh = await Promise.all(list.map((d) => tx.get(d.ref)));
    const ok = fresh.filter((d) => d.data().status === 'disetujui' && !d.data().paid);
    const total = ok.reduce((a, d) => a + (d.data().earned || 0), 0);
    if (total <= 0) return { ok: false, msg: 'Belum ada penghasilan yang siap dicairkan' };
    ok.forEach((d) => tx.update(d.ref, { paid: true, paidAt: Date.now() }));
    tx.update(db.doc('users/' + uid), { balance: FV.increment(total) });
    bon(tx, uid, 'Bonus uang GVCLIPPER', total, ok.length + ' video disetujui');
    note(tx, uid, 'Pencairan GVCLIPPER berhasil', rp(total) + ' masuk ke saldo PPOB kamu.');
    return { ok: true, msg: rp(total) + ' masuk ke saldo PPOB', amount: total };
  });
}

// Pastikan pengguna punya kode referral. Memakai Admin SDK sehingga tidak terhalang aturan Firestore.
async function ensureRef(uid) {
  const ur = db.doc('users/' + uid), s = await ur.get();
  if (!s.exists) return { ok: false, msg: 'Akun tidak ditemukan' };
  const u = s.data();
  if (u.refCode) {
    const rc = db.doc('refCodes/' + u.refCode), rs = await rc.get();
    if (!rs.exists) await rc.set({ uid, createdAt: Date.now() });
    return { ok: true, code: u.refCode };
  }
  const base = (String(u.name || 'GV').replace(/[^A-Za-z]/g, '').slice(0, 8) || 'GV').toUpperCase();
  for (let i = 0; i < 8; i++) {
    const code = base + Math.floor(1e6 + Math.random() * 9e6), rc = db.doc('refCodes/' + code);
    try { await rc.create({ uid, createdAt: Date.now() }); await ur.update({ refCode: code }); return { ok: true, code }; } catch (e) { /* kode bentrok, coba lagi */ }
  }
  return { ok: false, msg: 'Gagal membuat kode referral' };
}

// Simpan foto profil (data URL kecil). Dipakai sebagai cadangan jika update langsung dari aplikasi ditolak.
async function setPhoto(uid, photo) {
  const p = String(photo || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)) return { ok: false, msg: 'Format foto tidak valid' };
  if (p.length > 400000) return { ok: false, msg: 'Foto terlalu besar' };
  await db.doc('users/' + uid).update({ photo: p });
  return { ok: true };
}

module.exports = async (req, res) => {
  if (initErr) return res.status(500).json({ ok: false, error: 'Kunci Firebase bermasalah: ' + initErr.message });
  if (req.method === 'GET') { // dipanggil Vercel Cron: tutup balapan bulan lalu & bagikan hadiah
    if (process.env.CRON_SECRET && req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
    try { await settle(await cfg()); await flush(); return res.json({ ok: true }); } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    const me = await admin.auth().verifyIdToken(tok), b = req.body || {};
    if (b.action === 'redeem') { const o = await redeem(me.uid, b.code); await flush(); return res.json(o); }
    if (b.action === 'claim') { const o = await claim(me.uid, b.rewardId, b.fields); await flush(); return res.json(o); }
    if (b.action === 'claimset') { const o = await claimSet(me.uid, b.id, b.status); await flush(); return res.json(o); }
    if (b.action === 'clipwd') { const o = await clipWithdraw(me.uid); await flush(); return res.json(o); }
    if (b.action === 'ensureref') return res.json(await ensureRef(me.uid));
    if (b.action === 'setphoto') return res.json(await setPhoto(me.uid, b.photo));
    if (b.action === 'sync') {
      try { await ensureRef(me.uid); } catch (e) { console.warn('ensureRef', e.message); }
      const C = await cfg();
      let target = me.uid;
      if (b.targetUid && b.targetUid !== me.uid) {
        const a = await db.doc('users/' + me.uid).get();
        if (a.exists && a.data().role === 'admin') target = b.targetUid;
      }
      const snap = await db.collection('orders').where('uid', '==', target).get();
      const ids = snap.docs.filter((d) => d.data().status === 'berhasil' && !d.data().rewardDone).map((d) => d.id).slice(0, 200);
      for (const id of ids) await processOrder(id, C);
      await settle(C);
      await flush();
      return res.json({ ok: true, processed: ids.length });
    }
    return res.status(400).json({ error: 'action tidak dikenal' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
module.exports.processOrder = processOrder; module.exports.cfg = cfg; module.exports.flush = flush;
