// /api/haybi.js — satu-satunya pintu frontend ke provider H2H (HAYBI, dan PunyaKios untuk produk yang provider-nya 'punyakios').
// Kredensial TIDAK pernah keluar dari server. Nama file dipertahankan supaya frontend yang sudah terpasang tetap jalan.
// Semua request wajib login (Firebase ID token), body JSON: { action, ... }
//   ADMIN saja : saldo | produk {kategori?,operator?} | harga {produk}            (HAYBI)
//                harga_sync {mode: dry|apply|on|off|status}  (harga jual = modal HAYBI + margin tetap)
//                pk_saldo | pk_produk {category?,provider?} | pk_untung {days?}   (PunyaKios)
//                mb_saldo | mb_produk                                                      (MangBeli)
//   Semua pengguna login: cek_nama {brand,target,zone?}  -> cek nama akun e-wallet/game lewat produk "cek nama" HAYBI (SKU diatur admin di settings/cekNama)
//   Pemilik/admin: kirim {orderId}   -> kirim pesanan (yang sudah dibuat & saldo sudah terpotong) ke HAYBI
//                  status {orderId}  -> cek status pesanan ke HAYBI & perbarui bila sudah sukses
// Kode produk, nomor tujuan, dan harga TIDAK dipercaya dari browser: selalu dibaca ulang dari Firestore.
const admin = require('firebase-admin');
const H = require('./_haybi');
const PK = require('./_punyakios');
const MB = require('./_mangbeli');
const crypto = require('crypto');
const { finalize, syncOrder } = require('./_orders');
const { sendPush } = require('./_push');
const HS = require('./_hargasync');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const fail = (code, msg) => Object.assign(new Error(msg), { http: code });
const CODE_RE = /^[A-Za-z0-9._\-]{1,64}$/;
const TARGET_RE = /^[A-Za-z0-9._\-@() ]{3,64}$/;

async function whoami(req, db) {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (!tok) throw fail(401, 'Belum login');
  let me; try { me = await admin.auth().verifyIdToken(tok); } catch (e) { throw fail(401, 'Sesi tidak valid, login ulang'); }
  const d = await db.doc('users/' + me.uid).get();
  return { uid: me.uid, isAdmin: d.exists && d.data().role === 'admin' };
}

async function kirim(db, who, orderId, opts) {
  const quick = !!(opts && opts.quick); // quick: dipanggil dari server (webhook/penyapu) — jangan menunggu lama, status dicek lewat jalur biasa
  const T0 = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ref = 'GV' + orderId, prov = 'haybi'; // ref deterministik per pesanan: kirim ulang tidak membuat transaksi ganda
  let ord = null, prod = null;
  await db.runTransaction(async (tx) => {
    const or = db.collection('orders').doc(orderId), s = await tx.get(or);
    if (!s.exists) throw fail(404, 'Pesanan tidak ditemukan');
    const x = s.data();
    if (x.uid !== who.uid && !who.isAdmin) throw fail(403, 'Bukan pesananmu');
    if (x.status !== 'pending') throw fail(409, 'Pesanan sudah final');
    if (x.haybiRef) throw fail(409, 'Pesanan sudah pernah dikirim ke HAYBI');
    if (x.bebas) { // bebas nominal e-wallet: SKU & admin dibaca ulang dari settings/bebas, bukan dari browser
      const cs = await tx.get(db.doc('settings/bebas')), c = (cs.exists && cs.data()[x.bebas]) || {};
      const pr = Number(x.price), fee = Number(x.fee), tot = Number(x.total);
      if (!c.sku) { ord = null; return; }
      if (!Number.isInteger(pr) || pr < 1000 || pr > 200000) throw fail(400, 'Nominal harus Rp1.000 - Rp200.000');
      if (!(fee >= Number(c.fee || 0)) || tot !== pr + fee - (Number(x.discount) || 0)) throw fail(400, 'Biaya admin / total tidak sesuai');
      if (!CODE_RE.test(String(c.sku))) throw fail(400, 'Kode produk (SKU) tidak valid');
      if (!TARGET_RE.test(String(x.target || ''))) throw fail(400, 'Nomor tujuan tidak valid');
      tx.update(or, { haybiRef: ref, haybiState: 'sending', provider: 'haybi', updatedAt: Date.now() });
      ord = x; prod = { sku: c.sku, bebas: true };
      return;
    }
    if (!x.productId) { ord = null; return; } // tanpa produk terdaftar => diproses manual admin
    const ps = await tx.get(db.collection('products').doc(x.productId));
    if (!ps.exists || !ps.data().sku) { ord = null; return; } // produk belum punya kode HAYBI => manual
    const p = ps.data();
    // anti-manipulasi: nominal yang dibayar tidak boleh di bawah harga produk di database
    if (!(Number(x.total) + (Number(x.discount) || 0) >= Number(p.price)) || !(Number(x.price) >= Number(p.price))) throw fail(400, 'Nominal pesanan tidak sesuai harga produk');
    if (!TARGET_RE.test(String(x.target || ''))) throw fail(400, 'Nomor tujuan tidak valid');
    if (!CODE_RE.test(String(p.sku))) throw fail(400, 'Kode produk (SKU) tidak valid');
    // Provider dipilih admin per produk (field products.provider). Kosong / selain 'punyakios' = HAYBI seperti sebelumnya.
    if (p.provider === 'punyakios') {
      // Format tujuan game ID+Zone untuk PunyaKios tidak ada di dokumentasi resmi -> jangan ditebak, proses manual.
      if (x.zone) { ord = null; return; }
      prov = 'punyakios'; ref = 'PK' + orderId;
    } else if (p.provider === 'mangbeli') {
      // MangBeli: nomor tujuan game = gabungan user_id + zone_id (catatan resmi di /pricelist), sama seperti HAYBI. ref_id deterministik; order MangBeli idempotent per ref_id.
      prov = 'mangbeli'; ref = 'MB' + orderId;
    }
    tx.update(or, { haybiRef: ref, haybiState: 'sending', provider: prov, updatedAt: Date.now() });
    ord = x; prod = p;
  });
  if (!ord) return { ok: true, skipped: 'manual', note: 'Produk belum punya SKU / format tujuan belum didukung — diproses manual oleh admin' };
  if (prov === 'punyakios') return kirimPK(db, orderId, ref, ord, prod, quick);
  if (prov === 'mangbeli') return kirimMB(db, orderId, ref, ord, prod, quick);

  let res;
  try { const tujuan = (ord.zone && ord.gameId) ? String(ord.gameId).trim() + String(ord.zone).trim() : String(ord.target).trim(); // ID game + Zone menyatu
    res = await H.transaksi(ref, prod.sku, tujuan, prod.bebas ? { nominal_bebas: Number(ord.price) } : null); }
  catch (e) {
    // Hasil tidak diketahui (timeout/jaringan): JANGAN refund dulu, transaksi bisa saja sudah masuk di HAYBI.
    await db.collection('orders').doc(orderId).update({ haybiState: 'unknown', resellerMsg: e.message, updatedAt: Date.now() }).catch(() => {});
    return { ok: true, state: 'unknown', note: 'Status belum pasti, admin akan memeriksa' };
  }
  const d = res.data || {}, st = H.norm(d), db_ = db.collection('orders').doc(orderId);
  if (st === 'sukses') { await finalize(db, orderId, 'berhasil', d.sn || null, d.pesan || null); return { ok: true, state: 'sukses' }; }
  if (st === 'error') { await finalize(db, orderId, 'gagal', null, d.pesan || ('rc ' + (d.rc || '?'))); return { ok: true, state: 'error', pesan: d.pesan || null }; }
  // pending (atau respons tak dikenal): tunggu, jangan refund
  await db_.update({ haybiState: st === 'pending' ? 'pending' : 'unknown', resellerMsg: d.pesan || null, haybiRc: d.rc || null, updatedAt: Date.now() }).catch(() => {});
  // Otomatis: cek beberapa kali dalam hitungan detik supaya status langsung berubah tanpa klik manual.
  if (st === 'pending' && !quick) {
    for (const w of [3000, 5000, 6000]) {
      if (Date.now() - T0 > 20000) break;
      await sleep(w);
      try { const r = await syncOrder(db, orderId); if (r.state === 'sukses') return { ok: true, state: 'sukses' }; if (r.state === 'error' || r.state === 'gagal') break; } catch (e) { break; }
    }
  }
  return { ok: true, state: st === 'pending' ? 'pending' : 'unknown' };
}

// ---- PunyaKios ----
// Aturan: transaksi hanya dibuat SEKALI per pesanan (ref_id deterministik 'PK'+orderId + penanda haybiRef di transaksi di atas).
// Timeout / respons aneh = hasil TIDAK diketahui -> cek status, tidak refund, tidak kirim ulang.
async function kirimPK(db, orderId, ref, ord, prod, quick) {
  const T0 = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), or = db.collection('orders').doc(orderId);
  const mark = (o) => or.update({ ...o, updatedAt: Date.now() }).catch(() => {});
  const poll = async () => { // status asli dari endpoint cek status, beberapa kali dalam hitungan detik
    if (quick) return { ok: true, state: 'pending' };
    for (const w of [3000, 5000, 6000]) {
      if (Date.now() - T0 > 20000) break;
      await sleep(w);
      try { const r = await syncOrder(db, orderId); if (r.state === 'sukses') return { ok: true, state: 'sukses' }; if (r.state === 'gagal' || r.state === 'error') return { ok: true, state: 'error' }; } catch (e) { break; }
    }
    return { ok: true, state: 'pending' };
  };
  let res;
  try { res = await PK.order(ref, String(prod.sku), String(ord.target).trim()); }
  catch (e) {
    if (e.code === 'NOCFG') { // belum ada kredensial: tidak ada request yang terkirim -> lepas penanda, admin proses manual
      await or.update({ haybiRef: admin.firestore.FieldValue.delete(), haybiState: admin.firestore.FieldValue.delete(), provider: 'vip-reseller', updatedAt: Date.now() }).catch(() => {});
      return { ok: true, skipped: 'manual', note: 'PunyaKios belum dikonfigurasi — diproses manual oleh admin' };
    }
    await mark({ haybiState: 'unknown', resellerMsg: 'Status belum pasti, sedang dicek' }); // timeout/jaringan/bukan JSON
    return { ok: true, state: 'unknown', note: 'Status belum pasti, dicek ulang otomatis' };
  }
  const body = res.data || {}, d = body.data || {}, em = String(body.message || body.status || ('HTTP ' + res.http)).slice(0, 160);
  if (res.ok) { // HTTP 2xx saja BUKAN bukti berhasil: yang dipakai adalah status transaksinya
    const st = PK.norm(d.status);
    if (d.ref_id && d.ref_id !== ref) { await mark({ haybiState: 'unknown', resellerMsg: 'Respons tidak cocok, sedang dicek' }); return poll(); }
    if (st === 'sukses') { const c = Number(d.amount); await finalize(db, orderId, 'berhasil', d.sn || null, d.message || null, { cost: Number.isFinite(c) ? c : null, trx: d.trx_id || null }); return { ok: true, state: 'sukses' }; }
    if (st === 'error') { await finalize(db, orderId, 'gagal', null, 'Transaksi gagal di provider'); return { ok: true, state: 'error' }; }
    await mark({ haybiState: st === 'pending' ? 'pending' : 'unknown', resellerMsg: null });
    return poll();
  }
  if (res.http === 422) { await mark({ haybiState: 'pending' }); return poll(); } // TRX_DUPLICATE: ref_id sudah ada di provider -> ikuti statusnya, JANGAN order ulang
  if ([400, 401, 404, 429, 503].includes(res.http)) {
    // Penolakan yang tercantum di dokumentasi. Sebelum refund, pastikan transaksi memang tidak ada di provider (cek status).
    let conf = null; try { conf = await PK.status(ref); } catch (e) { conf = null; }
    if (conf && conf.http === 404) {
      await finalize(db, orderId, 'gagal', null, 'Ditolak provider (HTTP ' + res.http + ')');
      if (res.http !== 404) await sendPush(db, 'admin', 'PunyaKios menolak order', (ord.name || 'Pesanan') + ' · ' + em + ' (HTTP ' + res.http + '). Cek saldo / kredensial PunyaKios.', { tag: 'pk-rej-' + orderId, idem: 'pk-rej-' + orderId, event: 'provider:ditolak', url: '/?go=admin' }).catch(() => {});
      return { ok: true, state: 'error' };
    }
    if (conf && conf.ok) { await mark({ haybiState: 'pending' }); return poll(); }
    await mark({ haybiState: 'unknown', resellerMsg: 'Status belum pasti, sedang dicek' });
    return { ok: true, state: 'unknown', note: 'Penolakan belum terkonfirmasi, tidak di-refund otomatis' };
  }
  await mark({ haybiState: 'unknown', resellerMsg: 'Status belum pasti, sedang dicek' }); // 5xx lain / kode tak terdokumentasi
  return { ok: true, state: 'unknown' };
}

// ---- MangBeli ----
// Aturan sama seperti PunyaKios: transaksi dibuat SEKALI per pesanan (ref_id 'MB'+orderId + penanda haybiRef di transaksi di atas).
// Timeout / respons aneh = hasil TIDAK diketahui -> cek status, tidak refund. Status 'failed' = akhir (MangBeli mengembalikan saldonya sendiri) -> refund pelanggan.
async function kirimMB(db, orderId, ref, ord, prod, quick) {
  const T0 = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), or = db.collection('orders').doc(orderId);
  const mark = (o) => or.update({ ...o, updatedAt: Date.now() }).catch(() => {});
  const poll = async () => {
    if (quick) return { ok: true, state: 'pending' };
    for (const w of [3000, 5000, 6000]) {
      if (Date.now() - T0 > 20000) break;
      await sleep(w);
      try { const r = await syncOrder(db, orderId); if (r.state === 'sukses') return { ok: true, state: 'sukses' }; if (r.state === 'gagal' || r.state === 'error') return { ok: true, state: 'error' }; } catch (e) { break; }
    }
    return { ok: true, state: 'pending' };
  };
  const tujuan = (ord.zone && ord.gameId) ? String(ord.gameId).trim() + String(ord.zone).trim() : String(ord.target).trim();
  let res;
  try { res = await MB.order(ref, String(prod.sku), tujuan); }
  catch (e) {
    if (e.code === 'NOCFG') { // belum ada kredensial: tidak ada request yang terkirim -> lepas penanda, admin proses manual
      await or.update({ haybiRef: admin.firestore.FieldValue.delete(), haybiState: admin.firestore.FieldValue.delete(), provider: 'vip-reseller', updatedAt: Date.now() }).catch(() => {});
      return { ok: true, skipped: 'manual', note: 'MangBeli belum dikonfigurasi — diproses manual oleh admin' };
    }
    await mark({ haybiState: 'unknown', resellerMsg: 'Status belum pasti, sedang dicek' });
    return { ok: true, state: 'unknown', note: 'Status belum pasti, dicek ulang otomatis' };
  }
  const body = res.data || {}, d = body.data || {}, em = String(body.message || ('HTTP ' + res.http)).slice(0, 160);
  if (res.ok) { // HTTP 2xx saja BUKAN bukti berhasil: yang dipakai adalah status transaksinya
    const st = MB.norm(d.status), cost = Number(d.price);
    if (d.ref_id && d.ref_id !== ref) { await mark({ haybiState: 'unknown', resellerMsg: 'Respons tidak cocok, sedang dicek' }); return poll(); }
    if (Number.isFinite(cost) && cost >= 0) await db.collection('providerCosts').doc(orderId).set({ orderId, provider: 'mangbeli', cost, at: Date.now() }).catch(() => {}); // modal: koleksi server-only
    if (st === 'sukses') { await finalize(db, orderId, 'berhasil', d.sn || null, d.message || null, { cost: Number.isFinite(cost) ? cost : null, trx: null }); return { ok: true, state: 'sukses' }; }
    if (st === 'error') { await finalize(db, orderId, 'gagal', null, d.message || 'Transaksi gagal di provider'); return { ok: true, state: 'error' }; }
    await mark({ haybiState: st === 'pending' ? 'pending' : 'unknown', resellerMsg: null });
    return poll();
  }
  if ([400, 401, 402, 404, 429].includes(res.http)) {
    // Penolakan yang tercantum di dokumentasi (400 parameter, 401 key/sign, 402 saldo kurang, 404 SKU, 429 rate limit). Sebelum refund pastikan transaksi memang tidak ada di MangBeli.
    let conf = null; try { conf = await MB.status(ref); } catch (e) { conf = null; }
    if (conf && conf.http === 404) {
      await finalize(db, orderId, 'gagal', null, 'Ditolak provider (HTTP ' + res.http + ')');
      await sendPush(db, 'admin', 'MangBeli menolak order', (ord.name || 'Pesanan') + ' · ' + em + ' (HTTP ' + res.http + '). Cek saldo / SKU / kredensial MangBeli.', { tag: 'mb-rej-' + orderId, idem: 'mb-rej-' + orderId, event: 'provider:ditolak', url: '/?go=admin' }).catch(() => {});
      return { ok: true, state: 'error' };
    }
    if (conf && conf.ok) { await mark({ haybiState: 'pending' }); return poll(); }
    await mark({ haybiState: 'unknown', resellerMsg: 'Status belum pasti, sedang dicek' });
    return { ok: true, state: 'unknown', note: 'Penolakan belum terkonfirmasi, tidak di-refund otomatis' };
  }
  await mark({ haybiState: 'unknown', resellerMsg: 'Status belum pasti, sedang dicek' }); // 5xx lain / kode tak terdokumentasi
  return { ok: true, state: 'unknown' };
}

// ---- Cek nama akun (e-wallet / game) lewat produk "cek nama" di HAYBI ----
// SKU per brand diisi admin di settings/cekNama.map (kunci = nama brand huruf kecil). Format respons HAYBI untuk produk cek nama belum ada di
// dokumentasi yang kami pegang, jadi TIDAK ditebak: nama diambil apa adanya dari field sn (cadangan: pesan) dan admin bisa melihat respons mentahnya.
// Perlindungan biaya: hasil di-cache 10 menit per brand+tujuan, dan tiap pengguna dibatasi 30 cek per jam.
const CEK_MAX_PER_HOUR = 30, CEK_CACHE_MS = 10 * 60 * 1000;
async function cekNama(db, who, b) {
  const brand = String(b.brand || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60), target = String(b.target || '').trim(), zone = String(b.zone || '').replace(/\D/g, '').slice(0, 12);
  if (!brand) throw fail(400, 'brand tidak valid');
  if (!TARGET_RE.test(target)) throw fail(400, 'Nomor / ID tujuan tidak valid');
  const cs = await db.doc('settings/cekNama').get(), sku = cs.exists && cs.data().map ? String(cs.data().map[brand] || '') : '';
  if (!sku) return { ok: true, available: false };
  if (!CODE_RE.test(sku)) throw fail(400, 'Kode produk cek nama tidak valid');
  const tujuan = zone ? target + zone : target; // game ID + Zone menyatu (sama seperti transaksi)
  const key = crypto.createHash('md5').update(brand + '|' + sku + '|' + tujuan).digest('hex'), cr = db.doc('cekNamaCache/' + key);
  const cached = await cr.get();
  if (cached.exists && Date.now() - Number(cached.data().at) < CEK_CACHE_MS) return Object.assign({ ok: true, available: true, cached: true }, cached.data().res);
  // batas per pengguna (admin bebas)
  if (!who.isAdmin) {
    const lr = db.doc('cekNamaLog/' + who.uid);
    await db.runTransaction(async (tx) => {
      const l = await tx.get(lr), now = Date.now(), x = l.exists ? l.data() : {};
      const fresh = !x.start || now - x.start > 3600e3, n = fresh ? 0 : Number(x.n) || 0;
      if (n >= CEK_MAX_PER_HOUR) throw fail(429, 'Terlalu banyak cek nama. Coba lagi beberapa menit lagi.');
      tx.set(lr, { start: fresh ? now : x.start, n: n + 1 });
    });
  }
  const ref = H.newRef('CKN');
  let r;
  try { r = await H.transaksi(ref, sku, tujuan); }
  catch (e) { return { ok: true, available: true, found: null, note: 'Cek nama sedang tidak tersedia' }; }
  let d = r.data || {}, st = H.norm(d);
  if (st === 'pending' || st === 'unknown') { // beberapa kali cek status singkat
    for (const w of [1500, 2500]) {
      await new Promise((x) => setTimeout(x, w));
      try { const q = await H.cekStatus(ref); d = q.data || d; st = H.norm(d); if (st === 'sukses' || st === 'error') break; } catch (e) { break; }
    }
  }
  const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const res = { found: null };
  if (st === 'sukses') { const nm = clean(d.sn) || clean(d.pesan); res.found = nm ? true : false; if (nm) res.name = nm; else res.note = 'Provider tidak mengembalikan nama'; }
  else if (st === 'error') { res.found = false; res.note = clean(d.pesan) || 'Akun tidak ditemukan'; }
  else res.note = 'Cek nama sedang tidak tersedia';
  if (res.found !== null) await cr.set({ at: Date.now(), res }).catch(() => {});
  const out = Object.assign({ ok: true, available: true }, res);
  if (who.isAdmin) out.raw = { status: d.status, sn: d.sn, pesan: d.pesan, rc: d.rc };
  return out;
}

// Ringkasan admin: modal, penjualan, untung dari koleksi orderCosts (ditulis server saat transaksi sukses).
async function untung(db, days) {
  const d = Math.min(90, Math.max(1, Number(days) || 30)), since = Date.now() - d * 864e5;
  const q = await db.collection('orderCosts').where('at', '>=', since).orderBy('at', 'desc').limit(1000).get();
  let sales = 0, cost = 0, profit = 0; const recent = [];
  q.docs.forEach((s, i) => { const x = s.data(); sales += Number(x.total) || 0; cost += Number(x.cost) || 0; profit += Number(x.profit) || 0; if (i < 15) recent.push({ orderId: x.orderId, sku: x.sku, cost: x.cost, total: x.total, profit: x.profit, at: x.at }); });
  return { ok: true, days: d, count: q.size, truncated: q.size >= 1000, sales, cost, profit, recent };
}

async function status(db, who, orderId) {
  const s = await db.collection('orders').doc(orderId).get();
  if (!s.exists) throw fail(404, 'Pesanan tidak ditemukan');
  const x = s.data();
  if (x.uid !== who.uid && !who.isAdmin) throw fail(403, 'Bukan pesananmu');
  if (!x.haybiRef) throw fail(409, 'Pesanan ini belum dikirim ke provider');
  const r = await syncOrder(db, orderId), out = { ok: true, state: r.state };
  if (who.isAdmin && r.haybi) out.haybi = r.haybi; // detail mentah hanya untuk admin
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (initErr) return res.status(500).json({ error: 'Server belum siap (Firebase)' });
  try {
    const db = admin.firestore(), who = await whoami(req, db), b = req.body || {}, a = String(b.action || '');
    if (['saldo', 'produk', 'harga'].includes(a)) {
      if (!who.isAdmin) throw fail(403, 'Khusus admin');
      if (a === 'saldo') return res.status(200).json((await H.cekSaldo()).data);
      if (a === 'produk') {
        for (const k of ['kategori', 'operator']) if (b[k] != null && !/^[\w .\-]{1,40}$/.test(String(b[k]))) throw fail(400, k + ' tidak valid');
        return res.status(200).json((await H.produk(b.kategori, b.operator)).data);
      }
      if (!CODE_RE.test(String(b.produk || ''))) throw fail(400, 'Kode produk tidak valid');
      return res.status(200).json((await H.cekHarga(String(b.produk))).data);
    }
    if (a === 'cek_nama') return res.status(200).json(await cekNama(db, who, b));
    if (['mb_saldo', 'mb_produk'].includes(a)) {
      if (!who.isAdmin) throw fail(403, 'Khusus admin');
      if (a === 'mb_saldo') {
        const r = await MB.saldo();
        if (!r.ok) throw fail(502, 'MangBeli: ' + String((r.data && r.data.message) || 'HTTP ' + r.http).slice(0, 120));
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        return res.status(200).json({ ok: true, saldo: Number(r.data && r.data.data && r.data.data.balance) || 0, expected_webhook: host ? 'https://' + host + '/api/mangbeli-callback' : null });
      }
      const r = await MB.pricelist(), arr = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
      if (!r.ok) throw fail(502, 'MangBeli: ' + String((r.data && r.data.message) || 'HTTP ' + r.http).slice(0, 120));
      const list = arr.slice(0, 4000).map((x) => ({ sku: String(x.sku || ''), nama: String(x.product_name || ''), category: String(x.category || ''), brand: String(x.brand || ''), type: String(x.type || ''), price: Number(x.price) || 0, stock: String(x.stock || ''), note: x.note ? String(x.note).slice(0, 200) : '' }));
      return res.status(200).json({ ok: true, sandbox: !!(r.data && r.data.sandbox), count: list.length, products: list });
    }
    if (a === 'harga_sync') { // ADMIN: sinkron harga jual = modal HAYBI + margin tetap. mode: dry | apply | on | off | status
      if (!who.isAdmin) throw fail(403, 'Khusus admin');
      const m = String(b.mode || 'status'), ref = db.doc('settings/autoprice');
      if (m === 'on' || m === 'off') { await ref.set({ enabled: m === 'on', changedAt: Date.now() }, { merge: true }); return res.status(200).json({ ok: true, enabled: m === 'on' }); }
      if (m === 'dry' || m === 'apply') return res.status(200).json(await HS.run(db, { dry: m === 'dry' }));
      const s = await ref.get(); return res.status(200).json(Object.assign({ ok: true, enabled: false }, s.exists ? s.data() : {}));
    }
    if (['pk_saldo', 'pk_produk', 'pk_untung'].includes(a)) {
      if (!who.isAdmin) throw fail(403, 'Khusus admin');
      if (a === 'pk_untung') return res.status(200).json(await untung(db, b.days));
      if (a === 'pk_saldo') {
        const r = await PK.profile(), p = (r.data && r.data.data) || {};
        if (!r.ok) throw fail(502, 'PunyaKios: ' + String((r.data && (r.data.message || r.data.status)) || 'HTTP ' + r.http).slice(0, 120));
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        return res.status(200).json({ ok: true, name: p.name || null, saldo: Number(p.saldo) || 0, is_sandbox: !!p.is_sandbox, webhook_url: p.webhook_url || null, expected_webhook: host ? 'https://' + host + '/api/punyakios-callback' : null });
      }
      for (const k of ['category', 'provider']) if (b[k] != null && b[k] !== '' && !/^[\w .\-]{1,40}$/.test(String(b[k]))) throw fail(400, k + ' tidak valid');
      const r = await PK.produk({ category: b.category || '', provider: b.provider || '' }), p = (r.data && r.data.data) || {};
      if (!r.ok) throw fail(502, 'PunyaKios: ' + String((r.data && (r.data.message || r.data.status)) || 'HTTP ' + r.http).slice(0, 120));
      const list = (Array.isArray(p.products) ? p.products : []).slice(0, 3000).map((x) => ({ sku: String(x.sku || ''), nama: String(x.nama || ''), category: String(x.category || ''), provider: String(x.provider || ''), price: Number(x.price) || 0 }));
      return res.status(200).json({ ok: true, maintenance: !!p.maintenance, count: list.length, products: list });
    }
    if (a === 'kirim' || a === 'status') {
      if (!/^[A-Za-z0-9]{10,40}$/.test(String(b.orderId || ''))) throw fail(400, 'orderId tidak valid');
      return res.status(200).json(await (a === 'kirim' ? kirim : status)(db, who, String(b.orderId)));
    }
    throw fail(400, 'action tidak dikenal');
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message });
    if (e.code === 'NOCFG') return res.status(500).json({ error: e.message });
    if (e.code === 'TIMEOUT' || e.code === 'NETWORK' || e.code === 'BADRESP') return res.status(502).json({ error: e.message });
    console.error('haybi', e.message); // jangan log body/credential
    return res.status(500).json({ error: 'Terjadi kesalahan server' });
  }
};
module.exports.kirim = kirim;
