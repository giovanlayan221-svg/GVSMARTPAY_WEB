// Voucher PROMO (potongan harga produk). Bukan saldo dan bukan poin.
// v = salinan voucher milik pengguna (koleksi voucherRedeems: type, value, maxDiscount, minPurchase, expiresAt, status).
// Diskon dihitung dari HARGA PRODUK saja (biaya admin tidak didiskon) dan tidak pernah melebihi harga produk.
const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
function calc(v, price, now) {
  if (!v) return { ok: false, msg: 'Voucher tidak ditemukan' };
  if (v.status && v.status !== 'tersedia') return { ok: false, msg: v.status === 'terpakai' ? 'Voucher ini sudah terpakai' : 'Voucher tidak tersedia' };
  if (Number(v.expiresAt) > 0 && Number(v.expiresAt) < (now || Date.now())) return { ok: false, msg: 'Voucher sudah kedaluwarsa' };
  const min = Number(v.minPurchase) || 0;
  if (price < min) return { ok: false, msg: 'Voucher ini berlaku untuk belanja minimal ' + rp(min) };
  const val = Number(v.value) || 0, mx = Number(v.maxDiscount) || 0;
  let d = v.type === 'percent' ? Math.floor(price * val / 100) : val;
  if (v.type === 'percent' && mx > 0) d = Math.min(d, mx);
  d = Math.max(0, Math.min(Math.floor(d), price));
  if (d <= 0) return { ok: false, msg: 'Voucher tidak berlaku untuk pesanan ini' };
  return { ok: true, discount: d };
}
module.exports = { calc };
