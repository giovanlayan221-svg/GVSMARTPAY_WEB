// Sinkron harga otomatis: harga jual = modal HAYBI terbaru + margin tetap per produk.
// Contoh: modal 6.989, jual 7.000 -> margin 11. Modal turun jadi 6.900 -> jual jadi 6.911.
// Produk berprovider 'mangbeli' memakai modal dari pricelist MangBeli; 'punyakios' dari katalog PunyaKios; sisanya modal HAYBI.
// HANYA dipakai di server. Margin pertama kali dihitung dari (harga jual sekarang - modal sekarang), lalu disimpan di products.margin.
const H = require('./_haybi');
const MB = require('./_mangbeli');
const PK = require('./_punyakios');

const MAX_JUMP = 0.5;                 // modal berubah >50% dalam sekali sync = dicurigai, produk dilewati & dilaporkan
const CODE_KEYS = ['kode', 'code', 'sku', 'kode_produk', 'kode_sku', 'produk', 'id'];
const PRICE_KEYS = ['harga', 'price', 'harga_jual', 'harga_beli']; // urutan sama dengan tombol "Cocokkan SKU" di admin
const CODE_RE = /^[A-Za-z0-9._\-]{1,64}$/;

// ambil array objek terpanjang dari respons HAYBI (bentuk respons tidak dipaksa)
function pickArr(j) {
  let best = [];
  const walk = (v) => {
    if (Array.isArray(v)) { if (v.length && v[0] && typeof v[0] === 'object' && v.length > best.length) best = v; v.forEach(walk); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(j);
  return best;
}
function toItem(it) {
  let code = '';
  for (const k of CODE_KEYS) { const v = it[k]; if (v != null && CODE_RE.test(String(v))) { code = String(v); break; } }
  let price = 0;
  for (const k of PRICE_KEYS) { const v = Number(String(it[k] == null ? '' : it[k]).replace(/[^\d]/g, '')); if (v) { price = v; break; } }
  return { code, price };
}

// Map kode -> modal. Kode ganda dengan harga beda ditandai -1 (ambigu, dilewati).
async function fetchCosts() {
  const r = await H.produk();
  if (!r.ok) { const e = new Error('HAYBI menolak permintaan produk (HTTP ' + r.http + ')'); e.code = 'HAYBI'; throw e; }
  const items = pickArr(r.data).map(toItem).filter((x) => x.code && x.price > 0);
  if (!items.length) { const e = new Error('Daftar produk HAYBI kosong / format tidak dikenali — tidak ada harga yang diubah'); e.code = 'EMPTY'; throw e; }
  const m = new Map();
  for (const x of items) { if (!m.has(x.code)) m.set(x.code, x.price); else if (m.get(x.code) !== x.price) m.set(x.code, -1); }
  return { map: m, total: items.length };
}

// Map sku -> harga dari pricelist MangBeli (field resmi: sku, price). SKU ganda dengan harga beda ditandai -1.
async function fetchMB() {
  const r = await MB.pricelist();
  if (!r.ok) { const e = new Error('MangBeli menolak permintaan pricelist (HTTP ' + r.http + ')'); e.code = 'MANGBELI'; throw e; }
  const arr = Array.isArray(r.data && r.data.data) ? r.data.data : [], m = new Map();
  for (const it of arr) { const sku = String(it.sku || ''), price = Number(it.price); if (!CODE_RE.test(sku) || !(price > 0)) continue; if (!m.has(sku)) m.set(sku, price); else if (m.get(sku) !== price) m.set(sku, -1); }
  if (!m.size) { const e = new Error('Pricelist MangBeli kosong / format tidak dikenali — harga produk MangBeli tidak diubah'); e.code = 'EMPTY'; throw e; }
  return m;
}

// Map sku -> harga dari katalog PunyaKios (field resmi: products[].sku, products[].price). SKU ganda dengan harga beda ditandai -1.
async function fetchPK() {
  const r = await PK.produk({});
  if (!r.ok) { const e = new Error('PunyaKios menolak permintaan katalog (HTTP ' + r.http + ')'); e.code = 'PUNYAKIOS'; throw e; }
  const arr = Array.isArray(r.data && r.data.data && r.data.data.products) ? r.data.data.products : [], m = new Map();
  for (const it of arr) { const sku = String(it.sku || ''), price = Number(it.price); if (!CODE_RE.test(sku) || !(price > 0)) continue; if (!m.has(sku)) m.set(sku, price); else if (m.get(sku) !== price) m.set(sku, -1); }
  if (!m.size) { const e = new Error('Katalog PunyaKios kosong / format tidak dikenali — harga produk PunyaKios tidak diubah'); e.code = 'EMPTY'; throw e; }
  return m;
}

async function run(db, opts) {
  const dry = !!(opts && opts.dry), now = Date.now();
  const snap = await db.collection('products').get();
  let hasHB = false, hasMB = false, hasPK = false;
  snap.forEach((d) => { const p = d.data(); if (!p.sku || p.autoPrice === false) return; if (p.provider === 'punyakios') hasPK = true; else if (p.provider === 'mangbeli') hasMB = true; else hasHB = true; });
  // Gangguan satu reseller tidak boleh menggagalkan sinkron reseller lain.
  let hb = { map: new Map(), total: 0 }, hbErr = null;
  if (hasHB) { try { hb = await fetchCosts(); } catch (e) { hbErr = e.message; } }
  let mbMap = null, mbErr = null;
  if (hasMB) { try { mbMap = await fetchMB(); } catch (e) { mbErr = e.message; } }
  let pkMap = null, pkErr = null;
  if (hasPK) { try { pkMap = await fetchPK(); } catch (e) { pkErr = e.message; } }
  if (hasHB && hbErr && !mbMap && !pkMap) { const e = new Error(hbErr); e.code = 'HAYBI'; throw e; } // semua gagal = lapor sebagai error
  const stats = { checked: 0, changed: 0, baseline: 0, notfound: 0, skipped: 0, haybi: hb.total, mangbeli: mbMap ? mbMap.size : 0, punyakios: pkMap ? pkMap.size : 0 };
  const changes = [], flags = [], writes = [];
  snap.forEach((d) => {
    const p = d.data();
    if (!p.sku || p.autoPrice === false) return;
    const isMB = p.provider === 'mangbeli', isPK = p.provider === 'punyakios', pname = isPK ? 'PunyaKios' : isMB ? 'MangBeli' : 'HAYBI';
    const src = isPK ? pkMap : isMB ? mbMap : (hbErr ? null : hb.map);
    if (!src) { stats.skipped++; if (flags.length < 40) flags.push({ id: d.id, name: p.name || p.sku, sku: String(p.sku), why: pname + ': ' + ((isPK ? pkErr : isMB ? mbErr : hbErr) || 'daftar harga tidak tersedia') }); return; }
    stats.checked++;
    const sku = String(p.sku), name = p.name || sku, price = Number(p.price);
    const cost = src.get(sku);
    if (cost === undefined) { stats.notfound++; return; }
    const flag = (why) => { stats.skipped++; if (flags.length < 40) flags.push({ id: d.id, name, sku, why }); };
    if (cost === -1) return flag('kode ganda di ' + pname + ', harga beda');
    if (!(price > 0)) return flag('harga jual kosong');
    let margin = Number(p.margin);
    const hasMargin = p.margin != null && Number.isFinite(margin) && margin >= 0;
    if (!hasMargin) {
      if (price < cost) return flag('harga jual di bawah modal (' + price + ' < ' + cost + ')');
      margin = price - cost;
    }
    const oldCost = Number(p.cost);
    if (oldCost > 0 && Math.abs(cost - oldCost) / oldCost > MAX_JUMP) return flag('modal berubah drastis (' + oldCost + ' → ' + cost + ')');
    const np = Math.round(cost + margin);
    if (np === price && cost === oldCost && hasMargin) return;
    const upd = { cost, margin, costAt: now };
    if (np !== price) { upd.price = np; stats.changed++; if (changes.length < 60) changes.push({ id: d.id, name, sku, old: price, price: np, cost }); }
    else if (!hasMargin) stats.baseline++;
    writes.push([d.ref, upd]);
  });
  if (!dry) {
    for (let i = 0; i < writes.length; i += 400) {
      const b = db.batch();
      writes.slice(i, i + 400).forEach(([ref, u]) => b.update(ref, u));
      await b.commit();
    }
    await db.doc('settings/autoprice').set({ lastRun: now, lastStats: stats, lastChanges: changes.slice(0, 30), lastFlags: flags.slice(0, 20) }, { merge: true });
  }
  return { ok: true, dry, stats, changes, flags };
}

module.exports = { run, pickArr, toItem };
