// /api/manifest.js: manifest PWA yang sama persis, ditambah related_applications berisi alamat situs ini
// supaya browser bisa mendeteksi apakah aplikasi sudah terpasang (navigator.getInstalledRelatedApps).
const BASE = {
  "id": "/",
  "name": "GVSMARTPAY",
  "short_name": "GVSMARTPAY",
  "description": "Aplikasi PPOB & QRIS GVSMARTPAY",
  "start_url": "/?source=pwa",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#ffffff",
  "theme_color": "#7c3aed",
  "lang": "id",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icon-192-maskable.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "maskable"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icon-512-maskable.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ],
  "prefer_related_applications": false
};
module.exports = (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const m = Object.assign({}, BASE, { related_applications: [{ platform: 'webapp', url: 'https://' + host + '/manifest.webmanifest' }] });
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).send(JSON.stringify(m));
};
