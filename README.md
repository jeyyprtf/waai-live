# stev live

Voice twin of Stev (untuk Ell). Share brain dengan `waai`:

- system prompt ← `../waai/persona.js`
- memories ← `../waai/store.json` (Elok)
- model: `gemini-3.1-flash-live-preview`

## run lokal

```bash
cp .env.example .env
# isi GEMINI_API_KEY + LIVE_PASSWORD
npm i && npm start
# → http://localhost:8787
```

Pakai headphone biar gak echo.

## deploy VPS + domain Cloudflare (nanti)

Server sudah:
- `HOST=0.0.0.0` — bind semua interface
- cookie `Secure` otomatis kalau `X-Forwarded-Proto: https` (Cloudflare/nginx)

Pola tipikal:
1. Clone `waai` + `waai-live` di VPS (path `WAAI_ROOT` benar).
2. `pm2 start server.js --name stev-live` (atau systemd).
3. Cloudflare Tunnel **atau** nginx reverse-proxy `https://stev.domainmu.com` → `http://127.0.0.1:8787`.
4. DNS domain di Cloudflare (proxy orange cloud OK untuk HTTPS ke browser; Live WS browser→Google **langsung**, gak lewat servermu).

Mic butuh HTTPS di production (browser policy) — Cloudflare SSL cukup.

## arsitektur

```
browser ──password──► server.js ──baca──► waai/persona.js + store.json
   │                      │
   │◄──── /api/session ───┘
   └──WSS──► Gemini Live (langsung, bukan lewat VPS)
```

## catatan

- API key ke browser setelah login (1 user). Upgrade ephemeral token kalau multi-user.
- `store.json` di-share read/write dengan bot WA.
