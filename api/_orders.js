// Logika pesanan bersama (dipakai haybi.js dan haybi-callback.js). Server-side saja.
const { sendPush } = require('./_push');
const H = require('./_haybi');
const PK = require('./_punyakios');
const MB = require('./_mangbeli');
const admin = require('firebase-admin');

const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

// Tetapkan status akhir (idempotent: hanya dari 'pending'). 'gagal' => saldo user dikembalikan.
// Hanya SATU notifikasi per pesanan per hasil (tag tetap), dan hanya saat status benar-benar berubah.
// extra (opsional, hanya PunyaKios): { cost, trx } -> modal & untung disimpan di orderCosts (koleksi khusus server/admin,
// TIDAK di dokumen pesanan karena dokumen pesanan bisa dibaca pelanggan).
async function finalize(db, orderId, st, sn, msg, extra) {
  let info = null;
  await db.runTransaction(async (tx) => {
    const or = db.collection('orders').doc(orderId), o = await tx.get(or);
    if (!o.exists) return;
    const x = o.data();
    if (x.status !== 'pending') return;
    let ur = null, u = null, rvr = null, rv = null;
    if (st === 'gagal') { ur = db.collection('users').doc(x.uid); u = await tx.get(ur); if (x.voucher) { rvr = db.doc('voucherRedeems/' + x.voucher + '_' + x.uid); rv = await tx.get(rvr); } }
    if (u && u.exists) tx.update(ur, { balance: (u.data().balance || 0) + x.total + (x.payMethod === 'qris' ? (Number(x.payFee) || 0) : 0) }); // pesanan QRIS: kembali ke SALDO GVSMARTPAY sebesar yang dibayar pelanggan
    if (rv && rv.exists && rv.data().status === 'terpakai') tx.update(rvr, { status: 'tersedia', usedAt: admin.firestore.FieldValue.delete(), orderId: admin.firestore.FieldValue.delete() }); // pesanan gagal: voucher kembali bisa dipakai
    tx.update(or, { status: st, sn: sn || null, resellerMsg: msg || null, haybiState: st === 'berhasil' ? 'sukses' : 'error', updatedAt: Date.now() });
    info = { uid: x.uid, name: x.name, total: x.total };
    if (st === 'berhasil' && extra && Number.isFinite(extra.cost) && extra.cost >= 0) {
      tx.set(db.collection('orderCosts').doc(orderId), { orderId, uid: x.uid, provider: x.provider || '', sku: x.sku || '', ref: x.haybiRef || '', trx: extra.trx || null, cost: extra.cost, total: Number(x.total) || 0, profit: (Number(x.total) || 0) - extra.cost, at: Date.now() });
    }
  });
  if (!info) return false;
  const T = st === 'berhasil'
    ? ['Pesanan berhasil', `${info.name} · ${rp(info.total)} telah selesai diproses.` + (sn ? ' SN: ' + sn : '')]
    : ['Pesanan gagal & saldo dikembalikan', `${info.name} · ${rp(info.total)} dibatalkan, saldo sudah dikembalikan.`];
  if (st === 'berhasil') { try { const R = require('./reward'); await R.processOrder(orderId, await R.cfg()); await R.flush(); } catch (e) { console.warn('reward', e.message); } }
  await db.collection('notifications').add({ uid: info.uid, type: 'order', title: T[0], body: T[1], read: false, createdAt: Date.now() });
  await sendPush(db, info.uid, T[0], T[1], { tag: 'order-' + orderId + '-' + st, idem: 'order-' + orderId + '-' + st, event: 'order:' + st, url: '/?go=riw' }).catch((e) => console.warn('push order', orderId, e && e.message));
  return true;
}

// Cek status ke provider yang dipakai pesanan (x.provider: 'punyakios' atau HAYBI sebagai default).
// Hasil seragam: { st: 'sukses'|'pending'|'error'|'unknown'|'notfound', sn, msg, cost, trx, raw }
async function checkProvider(x) {
  if (x.provider === 'punyakios') {
    const res = await PK.status(x.haybiRef);
    if (res.http === 404) return { st: 'notfound', msg: 'Transaksi tidak ditemukan di PunyaKios', raw: res.data };
    const d = (res.data && res.data.data) || {};
    if (!res.ok || (d.ref_id && d.ref_id !== x.haybiRef)) return { st: 'unknown', msg: (res.data && res.data.message) || ('HTTP ' + res.http), raw: res.data };
    const cost = Number(d.amount);
    return { st: PK.norm(d.status), sn: d.sn || null, msg: d.message || null, cost: Number.isFinite(cost) ? cost : null, trx: d.trx_id || null, raw: res.data };
  }
  if (x.provider === 'mangbeli') {
    const res = await MB.status(x.haybiRef);
    if (res.http === 404) return { st: 'notfound', msg: 'Transaksi tidak ditemukan di MangBeli', raw: res.data };
    const d = (res.data && res.data.data) || {};
    if (!res.ok || (d.ref_id && d.ref_id !== x.haybiRef)) return { st: 'unknown', msg: (res.data && res.data.message) || ('HTTP ' + res.http), raw: res.data };
    return { st: MB.norm(d.status), sn: d.sn || null, msg: d.message || null, raw: res.data };
  }
  const res = await H.cekStatus(x.haybiRef), d = res.data || {};
  return { st: H.norm(d), sn: d.sn || null, msg: d.pesan || null, rc: d.rc, raw: d };
}

// Cek status pesanan ke provider dan perbarui. Aman dipanggil berulang (tidak ada notifikasi ganda).
async function syncOrder(db, orderId) {
  const s = await db.collection('orders').doc(orderId).get();
  if (!s.exists) return { state: 'notfound' };
  const x = s.data();
  if (!x.haybiRef) return { state: 'nosend' };
  if (x.status !== 'pending') return { state: x.status };
  const c = await checkProvider(x), st = c.st, d = c.raw, pesan = c.msg;
  const who = x.provider === 'punyakios' ? 'PunyaKios' : x.provider === 'mangbeli' ? 'MangBeli' : 'HAYBI';
  if (st === 'sukses') {
    let extra = x.provider === 'punyakios' ? { cost: c.cost, trx: c.trx } : null;
    if (x.provider === 'mangbeli') { // modal dicatat server saat order dibuat (respons /order memuat price); respons /status tidak memuatnya
      try { const pc = await db.collection('providerCosts').doc(orderId).get(), cv = pc.exists ? Number(pc.data().cost) : NaN; if (Number.isFinite(cv)) extra = { cost: cv, trx: null }; } catch (e) { /* tanpa modal: pesanan tetap diselesaikan */ }
    }
    await finalize(db, orderId, 'berhasil', c.sn || null, pesan || null, extra); return { state: 'sukses', haybi: d };
  }
  // PunyaKios & MangBeli mendefinisikan 'failed' sebagai status AKHIR (saldo di sisi provider dikembalikan) -> refund. (HAYBI 'error' ambigu, jadi tidak di-refund otomatis.)
  if (st === 'error' && (x.provider === 'punyakios' || x.provider === 'mangbeli')) { await finalize(db, orderId, 'gagal', null, 'Transaksi gagal di provider'); return { state: 'gagal', haybi: d }; }
  if ((st === 'error' || st === 'notfound') && x.haybiState !== 'error') {
    // 'error' di cek-status bisa berarti gagal ATAU referensi tidak ketemu -> tidak di-refund otomatis.
    // Tandai sekali saja dan beri tahu admin satu kali (tidak berulang).
    await db.collection('orders').doc(orderId).update({ haybiState: 'error', resellerMsg: pesan || ('rc ' + (c.rc || '?')), updatedAt: Date.now() }).catch(() => {});
    await sendPush(db, 'admin', 'Pesanan perlu dicek', `${x.name} · ${who}: ${pesan || 'status error'}. Putuskan sukses/gagal di Admin > Pesanan.`, { tag: 'order-' + orderId + '-err', idem: 'order-' + orderId + '-err', event: 'order:perlu-dicek', url: '/?go=admin' }).catch((e) => console.warn('push err', orderId, e && e.message));
  }
  return { state: st === 'notfound' ? 'error' : st, haybi: d };
}

module.exports = { finalize, syncOrder };
