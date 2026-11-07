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
const CHK = new Map();                   // throttle cek status per instance (hemat panggilan ke PunyaKios)
const ID_RE = /^[A-Za-z0-9]{10,40}$/;
const PAID = new Set(['paid', 'success', 'settlement', 'completed', 'berhasil']);

async function create(db, uid, o, topup) {
  const isTop = topup !== undefined && topup !== null && topup !== '';   // TopUp saldo PPOB lewat QRIS (bukan pesanan produk)
  let ord;
  if (isTop) {
    const amt = Number(topup);
    if (!Number.isInteger(amt) || amt < 1000 || amt > 10000000) throw fail(400, 'Nominal topup minimal Rp1.000 dan maksimal Rp10.000.000');
    ord = { name: 'TopUp Saldo PPOB', cat: 'TopUp', target: 'Saldo PPOB', price: amt, fee: 0, bebas: '', pid: '', gid: '', zone: '', voucher: '' };
  } else ord = PAY.prepOrder(o);
  const us = await db.doc('users/' + uid).get();
  if (!us.exists) throw fail(404, 'Akun tidak ditemukan');
  const stale = () => fail(409, 'Harga atau biaya sudah berubah. Tutup lalu buka lagi halamannya.', { code: 'harga' });
  let sku = '';
  if (ord.bebas) {
    const bs = await db.doc('settings/bebas').get(), bc = (bs.exists && bs.data()[ord.bebas]) || {};
    if (ord.fee !== Number(bc.fee || 0)) throw stale();
  } else if (ord.pid) {
    const [ps, fls] = await Promise.all([db.doc('products/' + ord.pid).get(), db.doc('settings/flash').get()]);
    if (!ps.exists) throw fail(400, 'Produk tidak ditemukan');
    const p = ps.data();
    if (p.on === false) throw fail(400, 'Produk sedang tidak tersedia');
    if (!FL.okPrice(p, fls.exists ? fls.data() : null, ord.pid, ord.price, Date.now()) || ord.fee !== 0) throw stale();
    if (ord.price !== Number(p.price)) ord.promo = true; // harga Flash Sale / Promo yang sah saat QRIS dibuat
    sku = p.sku || '';
  }
  let disc = 0;   // voucher promo: potongan harga produk (divalidasi ulang di server)
  if (!isTop && ord.voucher) {
    const [rv, vm] = await Promise.all([db.doc('voucherRedeems/' + ord.voucher + '_' + uid).get(), db.doc('vouchers/' + ord.voucher).get()]);
    if (!rv.exists) throw fail(400, 'Voucher tidak ada di akunmu. Klaim kodenya dulu di menu Voucher.', { code: 'voucher' });
    if (vm.exists && vm.data().active === false) throw fail(400, 'Voucher ini sudah tidak aktif', { code: 'voucher' });
    const cv = V.calc(rv.data(), ord.price, Date.now());
    if (!cv.ok) throw fail(400, cv.msg, { code: 'voucher' });
    disc = cv.discount;
  }
  const base = ord.price + ord.fee - disc;
  if (base < 1000 || base > 50000000) throw fail(400, base < 1000 ? 'Total setelah voucher di bawah Rp1.000, QRIS tidak bisa dibuat. Bayar pakai saldo.' : 'Nominal QRIS maksimal Rp50.000.000');
  const now = Date.now();
  const act = await db.collection('qrisPay').where('uid', '==', uid).where('status', '==', 'menunggu').limit(10).get();
  const live = act.docs.filter((d) => (d.data().expiresAt || 0) > now && d.data().qris);
  // Pesanan yang sama persis dan QRIS-nya masih berlaku: tampilkan QRIS yang sama (bukan membuat QRIS baru), supaya tidak dobel dan tidak menumpuk.
  const same = live.find((d) => { const dd = d.data(), q = dd.order || {}; return (dd.kind || 'order') === (isTop ? 'topup' : 'order') && String(dd.voucher || '') === String(ord.voucher || '') && ['pid', 'bebas', 'target', 'gid', 'zone'].every((k) => String(q[k] || '') === String(ord[k] || '')) && q.price === ord.price && q.fee === ord.fee; });
  if (same) { const q = same.data(); return { ok: true, id: same.id, qris: q.qris, base: q.base, payFee: q.payFee, total: q.payTotal, expiresAt: q.expiresAt, resumed: true, kind: q.kind || 'order' }; }
  if (!isTop && ord.voucher && live.some((d) => d.data().voucher === ord.voucher)) throw fail(409, 'Voucher ini sedang dipakai di QRIS lain yang belum dibayar. Selesaikan atau tunggu kedaluwarsa.', { code: 'voucher' });
  if (live.length >= 5) throw fail(429, 'Masih ada 5 pembayaran QRIS yang belum dibayar. Selesaikan atau tunggu kedaluwarsa.');
  const ref = db.collection('qrisPay').doc(), id = ref.id, ext = 'GVQ' + id;
  await ref.set({ uid, userName: us.data().name || '', kind: isTop ? 'topup' : 'order', order: { ...ord, sku }, ...(disc ? { voucher: ord.voucher, discount: disc } : {}), base, extId: ext, status: 'membuat', createdAt: now, expiresAt: now + WINDOW_MS });
  let res;
  try { res = await PK.payCreate(ext, base, 'GVSMARTPAY ' + ord.name); }
  catch (e) { await ref.update({ status: 'gagal', err: String(e.message).slice(0, 100) }).catch(() => {}); e.detail = e.message; throw e; }
  const d = (res.data && res.data.data) || {};
  const qr = [d.qris_string, d.qr_string, d.qris, d.qr_code].find((v) => typeof v === 'string' && v.length > 20) || '';
  const tot = Number(d.total_amount != null ? d.total_amount : d.amount);       // yang HARUS dibayar pelanggan
  const fee = d.fee_amount != null && Number.isFinite(Number(d.fee_amount)) ? Number(d.fee_amount) : tot - base;
  // Tarif resmi PunyaKios: MDR 0,7% + Rp200. Batas longgar menolak angka tak masuk akal, tapi tidak menolak variasi bentuk respons.
  const sane = res.ok && qr && Number.isFinite(tot) && tot >= base && fee >= 0 && tot - base === fee && fee <= Math.round(base * 0.03) + 300;
  if (!sane) {
    const pm = String((res.data && (res.data.message || res.data.error || (res.data.data && res.data.data.message))) || '').replace(/\s+/g, ' ').slice(0, 160);
    const why = 'HTTP ' + res.http + (pm ? ' - ' + pm : '') + (res.ok && !qr ? ' (tanpa qris_string)' : '') + (res.ok && qr ? ' (nominal/biaya tidak cocok: base ' + base + ', total ' + tot + ', fee ' + fee + ')' : '');
    console.warn('pkqris create ditolak:', why, 'kunci respons:', Object.keys(d).join(','));   // tanpa isi QR / kredensial
    await ref.update({ status: 'gagal', err: why.slice(0, 300) }).catch(() => {});
    if (res.http === 401 || res.http === 400 || res.http === 403 || res.http === 422 || res.http === 503) await sendPush(db, 'admin', 'QRIS PunyaKios bermasalah', 'Pembuatan QRIS ditolak (' + why.slice(0, 120) + ').', { tag: 'pkq-err', idem: 'pkq-err-' + Math.floor(now / 3600e3), event: 'qris:error', url: '/?go=admin' }).catch(() => {});
    throw fail(502, 'QRIS belum bisa dibuat sekarang. Coba lagi sebentar atau bayar pakai saldo.', { detail: why });
  }
  const pe = Date.parse(d.expires_at), expiresAt = Number.isFinite(pe) && pe > now ? Math.min(pe, now + WINDOW_MS) : now + WINDOW_MS;
  await ref.update({ status: 'menunggu', trx: d.trx_id || null, qris: qr, payFee: fee, payTotal: tot, provExpires: d.expires_at || null, expiresAt });
  return { ok: true, id, qris: qr, base, payFee: fee, total: tot, expiresAt, kind: isTop ? 'topup' : 'order' };
}

// Kirim pesanan hasil QRIS ke provider (HAYBI/PunyaKios). Idempotent: kirim() hanya mengirim sekali per pesanan (penanda haybiRef di transaksi).
// Kegagalan TIDAK lagi diam: alasan dicatat di pesanan (sendErr/sendNote) dan admin dikabari sekali, supaya pesanan tidak menggantung tanpa jejak.
async function trySend(db, id, uid) {
  const or = db.collection('orders').doc(id);
  try {
    const r = await require('./haybi').kirim(db, { uid, isAdmin: true }, id, { quick: true });
    if (r && r.skipped) {
      const note = String(r.note || 'diproses manual').slice(0, 160);
      await or.update({ sendNote: note, updatedAt: Date.now() }).catch(() => {});
      await db.collection('notifications').add({ uid: 'admin', type: 'order', title: 'Pesanan QRIS perlu diproses manual', body: note + ' (pesanan ' + id + ')', read: false, createdAt: Date.now() }).catch(() => {});
      await sendPush(db, 'admin', 'Pesanan QRIS perlu diproses manual', note + ' (pesanan ' + id + ')', { tag: 'pkq-man-' + id, idem: 'pkq-man-' + id, event: 'qris:manual', url: '/?go=admin' }).catch(() => {});
    }
    return r || { ok: true };
  } catch (e) {
    if (e && e.http === 409) return { ok: true, note: 'sudah final / sudah terkirim' };   // pesanan sudah pernah dikirim atau sudah selesai: bukan kegagalan
    const msg = String((e && e.message) || e).slice(0, 160);
    console.warn('trySend', id, msg);
    await or.update({ sendErr: msg, updatedAt: Date.now() }).catch(() => {});
    await db.collection('notifications').add({ uid: 'admin', type: 'order', title: 'Pesanan QRIS belum terkirim ke provider', body: msg + ' (pesanan ' + id + ')', read: false, createdAt: Date.now() }).catch(() => {});
    await sendPush(db, 'admin', 'Pesanan QRIS belum terkirim ke provider', msg + ' (pesanan ' + id + ')', { tag: 'pkq-snd-' + id, idem: 'pkq-snd-' + id, event: 'qris:kirim-gagal', url: '/?go=admin' }).catch(() => {});
    return { ok: false, error: msg };
  }
}

// Satu-satunya tempat yang mengubah pembayaran menjadi pesanan / saldo. Idempotent lewat transaksi Firestore.
async function fulfill(db, id) {
  const ref = db.collection('qrisPay').doc(id), or = db.collection('orders').doc(id);
  let outcome = null, info = null;
  await db.runTransaction(async (tx) => {
    outcome = null; info = null;
    const s = await tx.get(ref);
    if (!s.exists || s.data().status !== 'menunggu') return;
    const q = s.data(), o = q.order, now = Date.now(), ur = db.doc('users/' + q.uid), us = await tx.get(ur), isTop = q.kind === 'topup';
    const rv = !isTop && q.voucher ? await tx.get(db.doc('voucherRedeems/' + q.voucher + '_' + q.uid)) : null;
    let ok = isTop || now <= q.expiresAt;
    if (ok) {  // produk harus masih sama seperti saat QRIS dibuat
      if (o.bebas) { const bs = await tx.get(db.doc('settings/bebas')), bc = (bs.exists && bs.data()[o.bebas]) || {}; ok = o.fee === Number(bc.fee || 0); }
      else if (o.pid) { const ps = await tx.get(db.doc('products/' + o.pid)); ok = ps.exists && ps.data().on !== false && o.fee === 0 && (Number(ps.data().price) === o.price || (o.promo === true && o.price < Number(ps.data().price))); } // promo yang sah saat QRIS dibuat tetap dihormati walau waktunya habis sebelum dibayar
    }
    info = { uid: q.uid, name: o.name, base: q.base, total: q.payTotal };
    if (!us.exists) { tx.update(ref, { status: 'perlu-dicek', paidAt: now }); outcome = 'perlu-dicek'; return; }
    if (isTop) {   // TopUp saldo PPOB: saldo bertambah sebesar nominal topup (biaya QRIS dibayar pelanggan dan tidak masuk saldo). Pembayaran telat tetap dikreditkan.
      tx.update(ur, { balance: (us.data().balance || 0) + q.base });
      tx.set(db.collection('topups').doc(id), { uid: q.uid, userName: q.userName || '', src: 'QRIS PunyaKios', amount: q.base, status: 'berhasil', auto: true, payRef: q.extId, createdAt: now });
      tx.update(ref, { status: 'selesai', paidAt: now });
      outcome = 'topup'; return;
    }
    if (ok) {
      if (rv && rv.exists && rv.data().status === 'tersedia') tx.update(rv.ref, { status: 'terpakai', usedAt: now, orderId: id });
      tx.set(or, { uid: q.uid, userName: q.userName || '', productId: o.pid || '', sku: o.sku || '', ...(o.bebas ? { bebas: o.bebas } : {}), name: o.name, cat: o.cat, target: o.target, ...(o.zone ? { gameId: o.gid, zone: o.zone } : {}), ...(q.discount ? { discount: q.discount, voucher: q.voucher } : {}), price: o.price, fee: o.fee, total: q.base, payFee: q.payFee, status: 'pending', provider: 'vip-reseller', payMethod: 'qris', payRef: q.extId, createdAt: now });
      tx.update(ref, { status: 'selesai', orderId: id, paidAt: now });
      outcome = 'selesai';
    } else {
      tx.update(ur, { balance: (us.data().balance || 0) + q.payTotal });
      tx.update(ref, { status: 'dikreditkan', paidAt: now });
      outcome = 'dikreditkan';
    }
  });
  if (outcome === 'topup') {
    await db.collection('notifications').add({ uid: info.uid, type: 'topup', title: 'Top up saldo berhasil', body: `${rp(info.base)} sudah masuk ke saldo PPOB kamu.`, read: false, createdAt: Date.now() }).catch(() => {});
    await sendPush(db, info.uid, 'Top up saldo berhasil', `${rp(info.base)} sudah masuk ke saldo PPOB kamu.`, { tag: 'topup-' + id, idem: 'topup-' + id, event: 'topup:ok', url: '/' }).catch(() => {});
  } else if (outcome === 'selesai') {
    await db.collection('notifications').add({ uid: info.uid, type: 'order', title: 'Pembayaran QRIS diterima', body: `${info.name} · ${rp(info.total)} sedang diproses.`, read: false, createdAt: Date.now() }).catch(() => {});
    await sendPush(db, info.uid, 'Pembayaran QRIS diterima', `${info.name} · ${rp(info.total)} sedang diproses.`, { tag: 'order-' + id + '-new', idem: 'qris-paid-' + id, event: 'qris:paid', url: '/?go=riw' }).catch(() => {});
    await trySend(db, id, info.uid); // gagal kirim: alasan dicatat + admin dikabari; dicoba ulang otomatis oleh pengecekan berikutnya dan penyapu
  } else if (outcome === 'dikreditkan') {
    await db.collection('notifications').add({ uid: info.uid, type: 'order', title: 'Pembayaran QRIS masuk ke saldo', body: `${rp(info.total)} ditambahkan ke saldo GVSMARTPAY kamu (waktu bayar habis atau harga produk berubah). Silakan pesan ulang.`, read: false, createdAt: Date.now() }).catch(() => {});
    await sendPush(db, info.uid, 'Pembayaran QRIS masuk ke saldo', `${rp(info.total)} ditambahkan ke saldo GVSMARTPAY kamu. Silakan pesan ulang.`, { tag: 'qris-credit-' + id, idem: 'qris-credit-' + id, event: 'qris:credit', url: '/' }).catch(() => {});
  } else if (outcome === 'perlu-dicek') {
    await sendPush(db, 'admin', 'Pembayaran QRIS perlu dicek', `Akun pembayaran ${id} tidak ditemukan. Cek manual di PunyaKios.`, { tag: 'pkq-chk-' + id, idem: 'pkq-chk-' + id, event: 'qris:cek', url: '/?go=admin' }).catch(() => {});
  }
  const st = (await ref.get()).data() || {};
  return { status: st.status, orderId: st.orderId || null, kind: st.kind || 'order' };
}

// Cek ke PunyaKios apakah QRIS sudah "paid"; kalau ya, proses lewat fulfill().
async function syncIntent(db, id, opts) {
  const ref = db.collection('qrisPay').doc(id), s = await ref.get();
  if (!s.exists) return { status: 'tidak-ada' };
  const q = s.data();
  if (q.status === 'selesai' && q.orderId) { // sudah lunas & pesanan dibuat: pastikan benar-benar terkirim ke provider (coba ulang bila belum)
    const k = 'send-' + id;
    if (Date.now() - (CHK.get(k) || 0) > 20000) {
      CHK.set(k, Date.now());
      const o = await db.collection('orders').doc(q.orderId).get();
      if (o.exists && o.data().status === 'pending' && !o.data().haybiRef && Date.now() - (o.data().createdAt || 0) > 15000) await trySend(db, q.orderId, q.uid);
    }
  }
  if (q.status !== 'menunggu') return { status: q.status, orderId: q.orderId || null, kind: q.kind || 'order' };
  if (!(opts && opts.force)) { if (Date.now() - (CHK.get(id) || 0) < 4000) return { status: 'menunggu' }; }
  CHK.set(id, Date.now()); if (CHK.size > 500) CHK.clear();
  const r = await PK.payStatus(q.extId), d = (r.data && r.data.data) || {};
  const expired = Date.now() > (q.expiresAt || 0);
  const pst = String(d.status || '').toLowerCase(), pm = String((r.data && r.data.message) || '').replace(/\s+/g, ' ').slice(0, 120);
  const dbg = { http: r.http, status: pst || null, amount: d.amount != null ? Number(d.amount) : null, msg: pm || null };
  await ref.update({ provHttp: r.http, provStatus: pst || null, provAmount: dbg.amount, provMsg: pm || null, lastCheckAt: Date.now() }).catch(() => {}); // jejak untuk diagnosa: status mentah dari PunyaKios
  // Status LUNAS dari endpoint cek status resmi. Nilai selain ini (pending/expired/failed/dll) BUKAN bukti bayar.
  if (!r.ok || !PAID.has(pst)) return { status: expired ? 'kadaluarsa' : 'menunggu', dbg };
  const amt = Number(d.total_amount != null ? d.total_amount : d.amount);
  if (!(amt === q.payTotal || amt === q.base)) { // dibayar kurang/tidak sama: jangan diproses otomatis
    await ref.update({ status: 'selisih', paidAmount: Number.isFinite(amt) ? amt : null }).catch(() => {});
    await sendPush(db, 'admin', 'Pembayaran QRIS tidak sesuai', `${rp(amt)} dibayar, seharusnya ${rp(q.payTotal)} (${id}). Cek manual.`, { tag: 'pkq-sel-' + id, idem: 'pkq-sel-' + id, event: 'qris:selisih', url: '/?go=admin' }).catch(() => {});
    return { status: 'selisih' };
  }
  return fulfill(db, id);
}


// Khusus admin: ringkasan pembayaran QRIS terbaru + nasib pesanannya. Sekaligus memeriksa ulang (dan memproses bila sudah lunas) agar tidak ada yang tertinggal.
async function diag(db) {
  const T0 = Date.now(), qs = await db.collection('qrisPay').orderBy('createdAt', 'desc').limit(6).get(), rows = [];
  for (const d of qs.docs) {
    let q = d.data();
    if (Date.now() - T0 < 20000 && (q.status === 'menunggu' || q.status === 'selesai')) { try { await syncIntent(db, d.id, { force: true }); q = (await d.ref.get()).data() || q; } catch (e) { q.err = q.err || String(e.message).slice(0, 100); } }
    let o = null;
    if (q.orderId) { const os = await db.collection('orders').doc(q.orderId).get(); if (os.exists) { const x = os.data(); o = { status: x.status, provider: x.provider || null, haybiState: x.haybiState || null, kirim: x.haybiRef ? 'sudah dikirim' : 'BELUM dikirim', sendErr: x.sendErr || null, sendNote: x.sendNote || null, resellerMsg: x.resellerMsg || null }; } else o = { status: 'pesanan tidak ditemukan' }; }
    rows.push({ id: d.id, name: (q.order && q.order.name) || '', user: q.userName || '', total: q.payTotal || q.base || 0, status: q.status, at: q.createdAt, provStatus: q.provStatus || null, provHttp: q.provHttp || null, provMsg: q.provMsg || null, err: q.err || null, order: o });
  }
  return { ok: true, rows };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (initErr) return res.status(500).json({ error: 'Server belum siap (Firebase)' });
  try {
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    if (!tok) throw fail(401, 'Belum login');
    let me; try { me = await admin.auth().verifyIdToken(tok); } catch (e) { throw fail(401, 'Sesi tidak valid, login ulang'); }
    const db = admin.firestore(), b = req.body || {}, a = String(b.action || '');
    const isAdm = async () => { const u = await db.doc('users/' + me.uid).get(); return u.exists && u.data().role === 'admin'; };
    if (a === 'create') { try { return res.status(200).json(await create(db, me.uid, b.order, b.topup)); } catch (e) { if (e.detail && await isAdm().catch(() => false)) e.adminMsg = ' [admin: ' + String(e.detail).slice(0, 200) + ']'; if (e.http && e.adminMsg) e.message += e.adminMsg; throw e; } }
    if (a === 'diag') { if (!(await isAdm())) throw fail(403, 'Khusus admin'); return res.status(200).json(await diag(db)); }
    if (a === 'check') {
      const id = String(b.id || '');
      if (!ID_RE.test(id)) throw fail(400, 'ID tidak valid');
      const s = await db.collection('qrisPay').doc(id).get();
      if (!s.exists || s.data().uid !== me.uid) throw fail(404, 'Pembayaran tidak ditemukan');
      const out = await syncIntent(db, id, { force: true });
      if (out.dbg && !(await isAdm().catch(() => false))) delete out.dbg;
      return res.status(200).json({ ok: true, ...out });
    }
    throw fail(400, 'action tidak dikenal');
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    if (e.code === 'NOCFG') return res.status(503).json({ error: 'QRIS belum aktif. Silakan bayar pakai saldo.' });
    if (e.code === 'TIMEOUT' || e.code === 'NETWORK' || e.code === 'BADRESP') return res.status(502).json({ error: 'QRIS belum bisa dibuat sekarang. Coba lagi sebentar atau bayar pakai saldo.' + (e.adminMsg || '') });
    console.error('pkqris', e && e.message); // jangan log body/kredensial
    return res.status(500).json({ error: 'Terjadi kesalahan server' });
  }
};
module.exports.syncIntent = syncIntent;
module.exports.fulfill = fulfill;
module.exports.trySend = trySend;
