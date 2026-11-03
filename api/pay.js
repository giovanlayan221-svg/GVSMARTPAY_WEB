// /api/pay.js — SEMUA yang menyentuh uang dan PIN lewat sini (Vercel Serverless + Firebase Admin).
// Browser TIDAK bisa lagi memotong saldo / membuat pesanan / mencairkan QRIS langsung ke Firestore
// (diblokir di firestore.rules.txt). Server selalu memverifikasi PIN dulu.
//   action: 'verify'  {pin}                       -> cek PIN (dipakai sebelum ubah PIN)
//           'setpin'  {pin, oldPin | reset}       -> buat / ubah PIN (reset butuh login password <5 menit lalu)
//           'order'   {pin, order:{...}}          -> buat pesanan + potong saldo PPOB
//           'wd'      {pin, amount}               -> cairkan saldo QRIS ke saldo PPOB
// Hash PIN disimpan di koleksi 'pins' (scrypt + salt acak) yang TIDAK bisa dibaca/ditulis browser.
// Salah PIN dihitung di server: 5x salah => terkunci 30 dtk, lalu 1, 2, 4, ... menit (maks 30 menit).
const admin = require('firebase-admin');
const crypto = require('crypto');
const { sendPush, sendPushWait } = require('./_push');
const V = require('./_voucher');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi di Vercel (atau belum di-Redeploy)');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const fail = (http, msg, extra) => Object.assign(new Error(msg), { http, extra: extra || {} });
const PIN_RE = /^\d{6}$/;
const weak = (p) => /^(\d)\1{5}$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p);
const BW = ['dana', 'ovo', 'gopay', 'shopeepay', 'linkaja'];
const TARGET_RE = /^[A-Za-z0-9._\-@() ]{3,64}$/;
const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const DEF = { dailyOrder: 5000000, dailyWd: 5000000, coolMax: 100000, coolHours: 24 }; // bisa diubah admin: settings/security
async function cfg(db) {
  const s = await db.doc('settings/security').get(), x = s.exists ? s.data() : {};
  const n = (k) => (Number.isFinite(Number(x[k])) && Number(x[k]) >= 0 && x[k] !== '' && x[k] !== null && x[k] !== undefined) ? Number(x[k]) : DEF[k];
  return { dailyOrder: n('dailyOrder'), dailyWd: n('dailyWd'), coolMax: n('coolMax'), coolHours: n('coolHours') };
}
const dayKey = (t) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10); // hari WIB
// Notifikasi keamanan ke pemilik akun (in-app + push). Gagal kirim tidak boleh menggagalkan transaksi.
async function secNote(db, uid, title, body, tag) {
  try { await db.collection('notifications').add({ uid, type: 'security', title, body, read: false, createdAt: Date.now() }); } catch (e) { console.warn('secNote', e.message); }
  try { await sendPush(db, uid, title, body, { tag }); } catch (e) { console.warn('secPush', e.message); }
}
// Batas harian + batas ketat 24 jam setelah PIN direset. Mengembalikan field pins yang harus ditulis.
function applyLimits(P, now, amt, kind, c) {
  const day = dayKey(now), same = P.day === day;
  const spent = same ? Number(P.spent || 0) : 0, wd = same ? Number(P.wdDay || 0) : 0;
  if (kind === 'order' && spent + amt > c.dailyOrder) throw fail(403, 'Batas transaksi harian ' + rp(c.dailyOrder) + ' tercapai. Sisa hari ini ' + rp(Math.max(0, c.dailyOrder - spent)), { code: 'limit' });
  if (kind === 'wd' && wd + amt > c.dailyWd) throw fail(403, 'Batas pencairan harian ' + rp(c.dailyWd) + ' tercapai. Sisa hari ini ' + rp(Math.max(0, c.dailyWd - wd)), { code: 'limit' });
  let coolUsed = Number(P.coolUsed || 0);
  if (Number(P.coolUntil || 0) > now) {
    if (coolUsed + amt > c.coolMax) throw fail(403, 'Setelah PIN direset, total transaksi dibatasi ' + rp(c.coolMax) + ' selama ' + c.coolHours + ' jam. Sisa batas: ' + rp(Math.max(0, c.coolMax - coolUsed)), { code: 'cool' });
    coolUsed += amt;
  }
  return { day, spent: spent + (kind === 'order' ? amt : 0), wdDay: wd + (kind === 'wd' ? amt : 0), coolUsed };
}
// Nominal tagihan simulasi (sama dengan rumus di aplikasi) dihitung ULANG di server supaya tidak bisa dimanipulasi.
const billPrice = (n) => 50000 + [...n].reduce((s, x) => s + Number(x), 0) * 1500;

const scrypt = (pin, salt) => crypto.scryptSync(pin, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
// Format lama (PIN yang dibuat sebelum verifikasi server): dicocokkan sekali lalu dimigrasi ke scrypt.
const legacyOk = (uid, pin, stored) => {
  const c = [sha(pin), sha(uid + ':' + pin), 'p2:' + crypto.pbkdf2Sync(pin, 'gvsp:' + uid, 150000, 32, 'sha256').toString('hex')];
  return c.some((x) => eq(x, stored));
};


// Satu langkah PIN di dalam transaksi: cek kunci, cocokkan hash, hitung salah-PIN, migrasi PIN lama.
// Mengembalikan {ok, upd} (upd = field pins yang harus ditulis pemanggil) atau {err,...}.
function pinStep(tx, uid, pin, pr, ur, P, U, now) {
  if (!P.h && !U.pinHash) return { err: 'nopin' };
  if ((P.lockUntil || 0) > now) return { err: 'locked', retry: Math.ceil((P.lockUntil - now) / 1000) };
  const ok = P.h ? eq(scrypt(pin, P.s), P.h) : legacyOk(uid, pin, U.pinHash);
  if (ok) {
    const upd = { fails: 0, level: 0, lockUntil: 0, updatedAt: now };
    if (!P.h) { // migrasi PIN lama: hash dipindah ke server, dihapus dari dokumen user
      const s = crypto.randomBytes(16).toString('hex');
      upd.s = s; upd.h = scrypt(pin, s);
      tx.update(ur, { hasPin: true, pinHash: admin.firestore.FieldValue.delete() });
    }
    return { ok: true, upd };
  }
  const fails = (P.fails || 0) + 1;
  if (fails >= 5) {
    const level = (P.level || 0) + 1, ms = Math.min(30000 * Math.pow(2, level - 1), 1800000);
    tx.set(pr, { fails: 0, level, lockUntil: now + ms, updatedAt: now }, { merge: true });
    return { err: 'locked', retry: Math.ceil(ms / 1000), fresh: true };
  }
  tx.set(pr, { fails, updatedAt: now }, { merge: true });
  return { err: 'pin', left: 5 - fails };
}
async function pinFail(db, uid, res) {
  if (res.err === 'nopin') throw fail(409, 'Kamu belum punya PIN. Buat PIN dulu.', { code: 'nopin' });
  if (res.err === 'locked') {
    if (res.fresh) await secNote(db, uid, 'PIN terkunci sementara', 'Ada 5 kali salah memasukkan PIN. Kalau itu bukan kamu, segera ganti password akunmu.', 'pin-lock-' + uid);
    throw fail(429, 'PIN terkunci sementara karena terlalu banyak salah', { code: 'locked', retry: res.retry });
  }
  throw fail(401, 'PIN salah', { code: 'pin', left: res.left });
}

// Dipakai action 'verify' dan 'setpin' (oldPin).
async function verifyPin(db, uid, pin) {
  pin = String(pin || '');
  if (!PIN_RE.test(pin)) throw fail(400, 'PIN harus 6 digit angka', { code: 'pinfmt' });
  const pr = db.doc('pins/' + uid), ur = db.doc('users/' + uid);
  let res = null;
  await db.runTransaction(async (tx) => {
    res = null;
    const [ps, us] = await tx.getAll(pr, ur);
    const r = pinStep(tx, uid, pin, pr, ur, ps.exists ? ps.data() : {}, us.exists ? us.data() : {}, Date.now());
    if (r.ok) tx.set(pr, r.upd, { merge: true }); else res = r;
  });
  if (res) await pinFail(db, uid, res);
  return true;
}

async function setPin(db, decoded, body) {
  const uid = decoded.uid, pin = String(body.pin || '');
  if (!PIN_RE.test(pin)) throw fail(400, 'PIN harus 6 digit angka', { code: 'pinfmt' });
  if (weak(pin)) throw fail(400, 'PIN terlalu mudah ditebak (jangan angka kembar atau berurutan)', { code: 'weak' });
  const ps = await db.doc('pins/' + uid).get(), us = await db.doc('users/' + uid).get();
  if (!us.exists) throw fail(404, 'Akun tidak ditemukan');
  const has = (ps.exists && ps.data().h) || us.data().pinHash;
  if (has) {
    if (body.reset) {
      const age = Math.floor(Date.now() / 1000) - Number(decoded.auth_time || 0);
      if (age > 300) throw fail(401, 'Verifikasi password kedaluwarsa, ulangi dari "Lupa PIN"', { code: 'stale' });
    } else await verifyPin(db, uid, body.oldPin);
  }
  const s = crypto.randomBytes(16).toString('hex');
  const c = await cfg(db), now = Date.now(), reset = !!(has && body.reset);
  await db.doc('pins/' + uid).set({ s, h: scrypt(pin, s), fails: 0, level: 0, lockUntil: 0, updatedAt: now, ...(reset ? { coolUntil: now + c.coolHours * 3600e3, coolUsed: 0 } : {}) }, { merge: true });
  await db.doc('users/' + uid).update({ hasPin: true, pinHash: admin.firestore.FieldValue.delete() });
  await secNote(db, uid, has ? (reset ? 'PIN direset' : 'PIN diubah') : 'PIN dibuat',
    reset ? 'PIN kamu direset lewat password. Selama ' + c.coolHours + ' jam, total transaksi dibatasi ' + rp(c.coolMax) + '. Kalau bukan kamu, segera ganti password akunmu.' : (has ? 'PIN transaksi kamu baru saja diubah. Kalau bukan kamu, segera ganti password akunmu.' : 'PIN transaksi kamu aktif dan dipakai untuk semua transaksi.'), 'pin-set-' + uid + '-' + now);
  return { ok: true };
}

// Normalisasi & validasi pesanan TANPA database (cepat). Hasilnya dipakai lagi di dalam transaksi.
function prepOrder(o) {
  o = o || {};
  const name = String(o.name || '').trim().slice(0, 120), cat = String(o.cat || '').trim().slice(0, 60), target = String(o.target || '').trim();
  const price = Number(o.price), fee = Number(o.fee);
  // Game dengan Server/Zone (Mobile Legends, Honor of Kings): target yang dikirim ke HAYBI = ID game + Zone digabung tanpa spasi
  const gid = String(o.gid || '').trim(), zone = String(o.zone || '').trim();
  if (gid || zone) { if (!/^\d{3,20}$/.test(gid) || !/^\d{1,10}$/.test(zone) || target !== gid + zone) throw fail(400, 'ID game / Server tidak valid'); }
  if (!name || !cat) throw fail(400, 'Data pesanan tidak lengkap');
  if (!Number.isInteger(price) || price < 1 || !Number.isInteger(fee) || fee < 0) throw fail(400, 'Nominal tidak valid');
  const bebas = o.bebas ? String(o.bebas) : '', pid = bebas ? '' : String(o.pid || '');
  if (bebas) {
    if (!BW.includes(bebas)) throw fail(400, 'Layanan bebas nominal tidak dikenal');
    if (price < 1000 || price > 200000) throw fail(400, 'Nominal harus Rp1.000 - Rp200.000');
    if (!TARGET_RE.test(target)) throw fail(400, 'Nomor tujuan tidak valid');
  } else if (pid) {
    if (!TARGET_RE.test(target)) throw fail(400, 'Nomor tujuan tidak valid');
  } else { // tanpa produk: hanya Tagihan, nominal dihitung ulang
    if (cat !== 'Tagihan') throw fail(400, 'Produk tidak valid. Muat ulang halaman lalu coba lagi.');
    if (!/^\d{6,20}$/.test(target)) throw fail(400, 'Nomor pelanggan tidak valid');
    if (price !== billPrice(target) || fee !== 2500) throw fail(409, 'Harga atau biaya sudah berubah. Tutup lalu buka lagi halamannya.', { code: 'harga' });
  }
  const voucher = String(o.voucher || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
  return { name, cat, target, price, fee, bebas, pid, gid, zone, voucher };
}

// ORDER & WD: verifikasi PIN + validasi + potong saldo dalam SATU transaksi (1x baca, 1x tulis).
async function fastPay(db, uid, body, kind) {
  const pin = String(body.pin || '');
  if (!PIN_RE.test(pin)) throw fail(400, 'PIN harus 6 digit angka', { code: 'pinfmt' });
  let o = null, amt = 0;
  if (kind === 'order') o = prepOrder(body.order);
  else { amt = Number(body.amount); if (!Number.isInteger(amt) || amt < 1) throw fail(400, 'Nominal pencairan tidak valid'); }
  const pr = db.doc('pins/' + uid), ur = db.doc('users/' + uid), sr = db.doc('settings/security');
  const extra = kind === 'order' ? (o.bebas ? db.doc('settings/bebas') : (o.pid ? db.doc('products/' + o.pid) : null)) : null;
  const rvRef = kind === 'order' && o.voucher ? db.doc('voucherRedeems/' + o.voucher + '_' + uid) : null, vmRef = rvRef ? db.doc('vouchers/' + o.voucher) : null;
  const dest = kind === 'order' ? db.collection('orders').doc() : db.collection('qriswd').doc();
  const stale = () => fail(409, 'Harga atau biaya sudah berubah. Tutup lalu buka lagi halamannya.', { code: 'harga' });
  let res = null, out = null;
  await db.runTransaction(async (tx) => {
    res = null; out = null;
    const present = [pr, ur, sr, extra, rvRef, vmRef].filter(Boolean), snaps = await tx.getAll(...present), at = (r) => (r ? snaps[present.indexOf(r)] : null);
    const ps = at(pr), us = at(ur), ss = at(sr), xs = at(extra), rvs = at(rvRef), vms = at(vmRef);
    const now = Date.now(), P = ps.exists ? ps.data() : {}, U = us.exists ? us.data() : {};
    if (!us.exists) throw fail(404, 'Akun tidak ditemukan');
    const r = pinStep(tx, uid, pin, pr, ur, P, U, now);
    if (!r.ok) { res = r; return; }                      // PIN salah/terkunci: hitungan salah ikut tersimpan
    const sx = ss.exists ? ss.data() : {}, nn = (k) => (sx[k] !== undefined && sx[k] !== null && sx[k] !== '' && Number.isFinite(Number(sx[k])) && Number(sx[k]) >= 0) ? Number(sx[k]) : DEF[k];
    const c = { dailyOrder: nn('dailyOrder'), dailyWd: nn('dailyWd'), coolMax: nn('coolMax'), coolHours: nn('coolHours') };
    if (kind === 'order') {
      let sku = '';
      if (o.bebas) {
        const bc = (xs && xs.exists && xs.data()[o.bebas]) || {};
        if (o.fee !== Number(bc.fee || 0)) throw stale();
      } else if (o.pid) {
        if (!xs || !xs.exists) throw fail(400, 'Produk tidak ditemukan');
        const p = xs.data();
        if (p.on === false) throw fail(400, 'Produk sedang tidak tersedia');
        if (o.price !== Number(p.price) || o.fee !== 0) throw stale();
        sku = p.sku || '';
      }
      let disc = 0;  // voucher promo: potongan harga produk, divalidasi ulang di server
      if (o.voucher) {
        if (!rvs || !rvs.exists) throw fail(400, 'Voucher tidak ada di akunmu. Klaim kodenya dulu di menu Voucher.', { code: 'voucher' });
        if (vms && vms.exists && vms.data().active === false) throw fail(400, 'Voucher ini sudah tidak aktif', { code: 'voucher' });
        const cv = V.calc(rvs.data(), o.price, now);
        if (!cv.ok) throw fail(400, cv.msg, { code: 'voucher' });
        disc = cv.discount;
      }
      const total = o.price + o.fee - disc, key = (o.pid || o.bebas || o.cat) + '|' + o.target + '|' + total;
      const ot = (Array.isArray(P.ot) ? P.ot : []).filter((x) => now - x.t < 60000);
      if (ot.length >= 8) throw fail(429, 'Terlalu banyak transaksi. Tunggu sebentar lalu coba lagi.', { code: 'rate' });
      if (ot.some((x) => x.k === key && now - x.t < 15000)) throw fail(409, 'Transaksi yang sama baru saja dibuat. Cek Riwayat sebelum mengulang.', { code: 'dup' });
      const lim = applyLimits(P, now, total, 'order', c), b = Number(U.balance || 0);
      if (b < total) throw fail(402, 'Saldo tidak cukup', { code: 'saldo' });
      tx.update(ur, { balance: b - total });
      if (disc) tx.update(rvs.ref, { status: 'terpakai', usedAt: now, orderId: dest.id });
      tx.set(dest, { uid, userName: U.name || '', productId: o.pid, sku, ...(o.bebas ? { bebas: o.bebas } : {}), name: o.name, cat: o.cat, target: o.target, ...(o.zone ? { gameId: o.gid, zone: o.zone } : {}), ...(disc ? { discount: disc, voucher: o.voucher } : {}), price: o.price, fee: o.fee, total, status: 'pending', provider: 'vip-reseller', createdAt: now });
      tx.set(pr, { ...r.upd, ...lim, ot: ot.concat({ t: now, k: key }) }, { merge: true });
      out = { ok: true, orderId: dest.id, total };
    } else {
      const lim = applyLimits(P, now, amt, 'wd', c);
      if (amt > Number(U.qrisBalance || 0)) throw fail(402, 'Saldo QRIS tidak cukup', { code: 'saldo' });
      tx.update(ur, { balance: Number(U.balance || 0) + amt, qrisBalance: Number(U.qrisBalance || 0) - amt });
      tx.set(dest, { uid, userName: U.name || '', amount: amt, ok: true, msg: 'Dicairkan ke saldo PPOB', createdAt: now });
      tx.set(pr, { ...r.upd, ...lim }, { merge: true });
      out = { ok: true };
    }
  });
  if (res) await pinFail(db, uid, res);
  // Push HARUS ditunggu (maks 6 dtk): di Vercel proses dibekukan setelah respons dikirim, push yang tidak ditunggu sering hilang.
  if (kind === 'wd') await Promise.race([secNote(db, uid, 'Pencairan QRIS berhasil', rp(amt) + ' dicairkan dari saldo QRIS ke saldo PPOB. Kalau bukan kamu, segera ganti password.', 'wd-' + dest.id), new Promise((ok) => setTimeout(ok, 6000))]);
  if (kind === 'order' && out && out.ok) {
    const nm = o.name || 'Pesanan', tot = Number(o.price || 0) + Number(o.fee || 0);
    try { await db.collection('notifications').add({ uid: 'admin', type: 'order_new', title: 'Pesanan baru', body: nm + ' · ' + rp(tot), read: false, createdAt: Date.now() }); } catch (e) { console.warn('adminNote', e.message); }
    await sendPushWait(db, 'admin', 'Pesanan baru', nm + ' · ' + rp(tot), { tag: 'neworder-' + out.orderId, idem: 'neworder-' + out.orderId, event: 'order:baru', url: '/?go=admin' }, 6000);
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (initErr) return res.status(500).json({ error: 'Kunci Firebase bermasalah: ' + initErr.message });
  try {
    res.setHeader('Cache-Control', 'no-store');
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    if (!tok) throw fail(401, 'Belum login');
    let decoded; try { decoded = await admin.auth().verifyIdToken(tok); } catch (e) { throw fail(401, 'Sesi tidak valid, login ulang'); }
    const db = admin.firestore(), body = req.body || {}, uid = decoded.uid;
    let out;
    if (body.action === 'setpin') out = await setPin(db, decoded, body);
    else if (body.action === 'verify') { await verifyPin(db, uid, body.pin); out = { ok: true }; }
    else if (body.action === 'order') out = await fastPay(db, uid, body, 'order');
    else if (body.action === 'wd') out = await fastPay(db, uid, body, 'wd');
    else throw fail(400, 'Action tidak dikenal');
    return res.status(200).json(out);
  } catch (e) {
    if (!e.http) console.error(e);
    return res.status(e.http || 500).json(Object.assign({ error: e.message }, e.extra || {}));
  }
};
module.exports.prepOrder = prepOrder; // dipakai api/pkqris.js (validasi pesanan yang sama untuk pembayaran QRIS)
