// Harga Flash Sale / Promo (settings/flash) — dipakai /api/pay dan /api/pkqris supaya harga potongan benar-benar dibayar,
// dan tidak bisa dipalsukan dari browser. Struktur dokumen:
//   settings/flash = { sections: [ { id:'flash'|'promo', title, on:true|false, end:<ms epoch|0>, items:[ { pid, price, ... } ] } ] }
// Harga promo hanya sah kalau: bagian itu AKTIF, belum lewat waktu berakhir, dan lebih murah dari harga produk saat ini.
function promoPrice(doc, pid, now) {
  const secs = doc && Array.isArray(doc.sections) ? doc.sections : [];
  for (const s of secs) {
    if (!s || s.on !== true) continue;
    const end = Number(s.end || 0);
    if (end && now > end) continue;
    const it = (Array.isArray(s.items) ? s.items : []).find((x) => x && x.pid === pid);
    if (it) { const p = Number(it.price); if (Number.isInteger(p) && p > 0) return p; }
  }
  return 0;
}
// true kalau `price` boleh dibayar untuk produk p: harga normal, atau harga promo yang masih berlaku dan lebih murah.
function okPrice(p, flashDoc, pid, price, now) {
  const base = Number(p.price);
  if (price === base) return true;
  const f = promoPrice(flashDoc, pid, now);
  return f > 0 && f < base && price === f;
}
module.exports = { promoPrice, okPrice };
