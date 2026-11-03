// Pengirim push bersama (dipakai notify.js, pay.js, reward.js, _orders.js, reseller-callback.js).
// Pesan dikirim sebagai DATA-ONLY supaya service worker (app tertutup) dan halaman (app terbuka)
// sama-sama menampilkan notifikasi lewat showNotification — jadi masuk di kondisi apa pun.
const admin = require('firebase-admin');
const crypto = require('crypto');

const MAXTOK = 15;            // satu akun boleh punya banyak perangkat (HP, PWA, browser lain)
const TTL = '259200';         // 3 hari: HP yang mati/tidak ada sinyal tetap dapat pesan saat menyala lagi
const clean = (s) => String(s || '').replace(/[^A-Za-z0-9_.~%-]/g, '');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const LOG_DAYS = 14;          // pushLogs dihapus otomatis kalau TTL policy di field expireAt diaktifkan (opsional)
// Kode error FCM: MATI = token memang sudah tidak berlaku (satu-satunya alasan token dibuang);
// SEMENTARA = gangguan di sisi FCM/jaringan, token TIDAK dibuang dan dicoba ulang.
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const TRANSIENT = new Set(['messaging/internal-error', 'messaging/server-unavailable', 'messaging/quota-exceeded', 'messaging/message-rate-exceeded', 'messaging/unknown-error']);

// Tautan tujuan notifikasi: hanya jalur di dalam aplikasi ("/..."), tidak boleh alamat luar.
function safeUrl(u) { const s = String(u || '/'); return /^\/(?!\/)[\w\-./?=&%#]*$/.test(s) && s.length <= 200 ? s : '/'; }
// Tanda tangan konfirmasi tampil (service worker -> /api/notify action 'ack'). Tanpa env baru: diturunkan dari kunci service account.
function ackSig(lid) { return crypto.createHmac('sha256', process.env.PUSH_ACK_SECRET || process.env.FIREBASE_SERVICE_ACCOUNT || 'x').update('ack:' + lid).digest('hex').slice(0, 24); }

async function tokensFor(db, target) {
  // Token HANYA dibuang kalau FCM bilang sudah mati. Di sini cuma dibatasi jumlahnya (yang terbaru dipakai).
  const stale = [];
  const grab = (d) => {
    const x = d.data() || {}, all = [...new Set([...(Array.isArray(x.fcmTokens) ? x.fcmTokens : []), x.fcmToken].filter(Boolean))];
    all.slice(0, Math.max(0, all.length - MAXTOK)).forEach((t) => stale.push([d.id, t]));
    return all.slice(-MAXTOK);
  };
  let docs = [];
  if (target === 'all') docs = (await db.collection('users').get()).docs;
  else if (target === 'admin') docs = (await db.collection('users').where('role', '==', 'admin').get()).docs;
  else { const d = await db.collection('users').doc(target).get(); if (d.exists) docs = [d]; }
  const map = new Map(); // token -> uid
  docs.forEach((d) => grab(d).forEach((t) => map.set(t, d.id)));
  const FV = admin.firestore.FieldValue;
  stale.slice(0, 50).forEach(([uid, t]) => db.doc('users/' + uid).update({ fcmTokens: FV.arrayRemove(t) }).catch(() => {}));
  return map;
}

// Tag unik untuk TIAP kejadian (pesan dengan isi sama tidak lagi saling menimpa).
// Kejadian yang memang harus saling menggantikan (mis. status pesanan) memberi tag sendiri lewat extra.tag.
function makeTag(extra) {
  if (extra && extra.tag) return String(extra.tag).slice(0, 60);
  const n = (extra && extra.nonce) ? clean(extra.nonce).slice(0, 40) : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  return 'gv-' + n;
}

// Kirim ke daftar token. Hanya kegagalan SEMENTARA yang dicoba ulang (maks 2x, token yang gagal saja);
// token baru dianggap mati kalau FCM sendiri yang bilang begitu.
async function deliver(tokens, base) {
  let pending = tokens.slice(), sent = 0, retries = 0; const errors = [], dead = [];
  for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt) { retries++; await sleep(attempt === 1 ? 700 : 1500); }
    const next = [];
    for (let i = 0; i < pending.length; i += 500) {
      const chunk = pending.slice(i, i + 500);
      let r;
      try { r = await admin.messaging().sendEachForMulticast({ ...base, tokens: chunk }); }
      catch (e) { if (errors.length < 3) errors.push('call: ' + ((e && (e.code || e.message)) || e)); next.push(...chunk); continue; }
      sent += r.successCount;
      r.responses.forEach((x, j) => {
        if (x.success) return;
        const c = x.error && x.error.code;
        if (errors.length < 3) errors.push((c || '') + ': ' + ((x.error && x.error.message) || ''));
        if (DEAD.has(c)) dead.push(chunk[j]);
        else if (!c || TRANSIENT.has(c)) next.push(chunk[j]);
      });
    }
    pending = next;
  }
  return { sent, retries, errors, dead };
}

// extra: { url, tag, nonce, idem, event }
//  - idem  : kunci idempotensi. Peristiwa dengan idem yang sama TIDAK dikirim dua kali (kalau pengiriman sebelumnya sudah diterima FCM).
//  - hasil : dicatat di koleksi pushLogs (1 dokumen per pengiriman). "sent" = DITERIMA FCM, belum berarti tampil di HP.
//            Konfirmasi tampil datang dari service worker (field shown) dan hanya tersedia untuk pengiriman ke satu akun.
async function sendPush(db, target, title, body, extra) {
  const lref = extra && extra.idem ? db.collection('pushLogs').doc('i_' + clean(extra.idem).slice(0, 120)) : db.collection('pushLogs').doc();
  if (extra && extra.idem) {
    try { const o = await lref.get(); if (o.exists) { const x = o.data() || {}; if ((x.sent > 0) || (x.state === 'sending' && Date.now() - (x.at || 0) < 60000)) return { sent: 0, failed: 0, tokens: x.tokens || 0, duplicate: true }; } } catch (e) {}
  }
  const map = await tokensFor(db, target), tokens = [...map.keys()];
  const log = { at: Date.now(), target: String(target).slice(0, 40), title: String(title).slice(0, 80), event: String((extra && (extra.event || extra.tag)) || '').slice(0, 60), tokens: tokens.length, sent: 0, failed: 0, dead: 0, retries: 0, shown: 0, state: 'sending', expireAt: new Date(Date.now() + LOG_DAYS * 864e5) };
  const save = (o) => lref.set({ ...log, ...o }).catch((e) => console.warn('pushLog', e && e.message));
  if (!tokens.length) { await save({ state: 'no-token' }); return { sent: 0, failed: 0, tokens: 0, reason: 'no-token' }; }
  const tag = makeTag(extra);
  const data = { title: String(title), body: String(body || ''), url: safeUrl(extra && extra.url), tag, ts: String(Date.now()) };
  if (target !== 'all') { data.lid = lref.id; data.sig = ackSig(lref.id); } // konfirmasi tampil hanya untuk 1 akun / grup admin (hemat tulis)
  const base = { data, webpush: { headers: { Urgency: 'high', TTL: TTL, Topic: clean(tag).slice(0, 32) || 'gv' } }, android: { priority: 'high', ttl: Number(TTL) * 1000 } };
  const r = await deliver(tokens, base);
  const failed = tokens.length - r.sent;
  // buang token mati dari akun pemiliknya (hanya yang FCM nyatakan mati)
  const FV = admin.firestore.FieldValue;
  for (const t of r.dead) {
    const uid = map.get(t); if (!uid) continue;
    await db.doc('users/' + uid).update({ fcmTokens: FV.arrayRemove(t) }).catch(() => {});
    const u = await db.doc('users/' + uid).get();
    if (u.exists && u.data().fcmToken === t) await u.ref.update({ fcmToken: null }).catch(() => {});
  }
  await save({ sent: r.sent, failed, dead: r.dead.length, retries: r.retries, errors: r.errors, state: r.sent === 0 ? 'failed' : failed ? 'partial' : 'ok' });
  return { sent: r.sent, failed, tokens: tokens.length, errors: r.errors, logId: lref.id };
}

// Kirim dan TUNGGU hasilnya (maksimal ms). Di Vercel, proses dibekukan begitu respons dikirim,
// jadi push yang "tidak ditunggu" sering tidak pernah terkirim.
async function sendPushWait(db, target, title, body, extra, ms) {
  try { return await Promise.race([sendPush(db, target, title, body, extra), new Promise((ok) => setTimeout(() => ok({ timeout: true }), ms || 6000))]); }
  catch (e) { console.warn('push', e && e.message); return { error: String((e && e.message) || e) }; }
}

module.exports = { sendPush, sendPushWait, tokensFor, safeUrl, ackSig };
