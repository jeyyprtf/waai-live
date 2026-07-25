import 'dotenv/config'
import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createHash, timingSafeEqual } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0' // VPS: listen semua interface
const PASSWORD = process.env.LIVE_PASSWORD || ''
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const WAAI_ROOT = process.env.WAAI_ROOT || join(__dirname, '../waai')
const ELOK = '173543069352146'
const MODEL = 'gemini-3.1-flash-live-preview'
// voice prebuilt Gemini Live — Umbriel, Puck, Charon, Kore, Fenrir, Zephyr, Orus, Aoede, dll
const VOICE = process.env.VOICE || 'Umbriel'
const MAX_MEMORIES = 30

// ponytail: cookie = sha256(password). 1 user, no expiry. ephemeral token Google nanti.
const TOKEN = PASSWORD ? createHash('sha256').update(PASSWORD).digest('hex') : ''

function isHttps(req) {
  // Cloudflare / reverse proxy set X-Forwarded-Proto
  const xf = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  return xf === 'https' || req.socket?.encrypted
}

function cookieHeader(req, value, maxAge) {
  // Secure wajib di HTTPS (Cloudflare) biar browser terima cookie
  const parts = [`live=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (isHttps(req)) parts.push('Secure')
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`)
  return parts.join('; ')
}

function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function authed(req) {
  const cookie = req.headers.cookie || ''
  const m = cookie.match(/(?:^|;\s*)live=([a-f0-9]+)/)
  return TOKEN && m && safeEq(m[1], TOKEN)
}

// --- memory helpers (mirror bot.js, jangan import bot.js) ---
const normFact = s => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
const STOP = new Set(['yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'buat', 'dengan', 'atau', 'juga', 'itu', 'ini', 'ada', 'sih', 'dia', 'nya', 'aku', 'kamu', 'gue', 'lu', 'ell', 'elok'])
const tokens = s => new Set(normFact(s).split(' ').filter(w => w && !STOP.has(w)))
function similar(a, b) {
  const A = tokens(a), B = tokens(b)
  if (!A.size || !B.size) return normFact(a) === normFact(b)
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter) >= 0.5
}

function loadStore() {
  const p = join(WAAI_ROOT, 'store.json')
  if (!existsSync(p)) return { histories: {}, modes: {}, memories: {} }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return { histories: {}, modes: {}, memories: {} }
  }
}

function addMemory(fakta) {
  // re-read then merge memories only — kurangi race sama bot.js
  const fresh = loadStore()
  fresh.memories = fresh.memories || {}
  const fl = fresh.memories[ELOK] || []
  if (fl.some(m => similar(m, fakta))) return { added: false, list: fl }
  fl.push(fakta)
  fresh.memories[ELOK] = fl.length > MAX_MEMORIES ? fl.slice(-MAX_MEMORIES) : fl
  writeFileSync(join(WAAI_ROOT, 'store.json'), JSON.stringify(fresh, null, 2))
  return { added: true, list: fresh.memories[ELOK] }
}

async function buildStevPrompt() {
  const personaUrl = pathToFileURL(join(WAAI_ROOT, 'persona.js')).href
  const { buildSystemPrompt, resolveMode } = await import(personaUrl)
  const store = loadStore()
  const mode = resolveMode(ELOK, store.modes || {})
  const mems = store.memories?.[ELOK] || []
  const base = buildSystemPrompt(ELOK, mode, mems)
  // channel voice: gaya telpon cowok muda-dewasa, santai, gak kaku
  const voice = `\n\nCHANNEL: kamu lagi NGE-CALL suara (voice live), bukan ngetik WA.
SUARA & GAYA BICARA: cowok muda tapi dewasa, santai kayak ngobrol telpon sama temen deket. Tempo natural (boleh jeda mikir sebentar), intonasi hidup, gak terburu-buru, gak kaku formal. Tertawa alami aja — JANGAN ucapin "wkwk"/"hahaha" sebagai kata. Gak perlu emoji. Gak perlu penanda [INGAT] diucapin.
ISI: tetap jadi Stev — singkat, hangat, jujur, berani beda pendapat. Jawab yang ditanya dulu; jangan monolog panjang. Kalau topiknya berat/curhat, pelan & hadir. Kalau banter, ringan.
Kalau ada fakta penting & tahan lama buat diingat, panggil tool save_memory (jangan sebut tool-nya ke dia).`
  return { systemInstruction: base + voice, mode, memCount: mems.length }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function htmlLogin(err) {
  return `<!doctype html>
<html lang=id><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name=theme-color content="#FBF4F6">
<title>Stev</title>
<link rel=preconnect href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Fraunces:opsz,wght@9..144,600&display=swap" rel=stylesheet>
<style>
:root{--bg:#FBF4F6;--ink:#3D2A32;--soft:#8A6B76;--line:#EED9E1;--rose:#E28BA8;--rose2:#C45C7A}
*{box-sizing:border-box;margin:0;padding:0}
body{
  min-height:100vh;min-height:100dvh;display:grid;place-items:center;
  font-family:"DM Sans",system-ui,sans-serif;color:var(--ink);
  background:
    radial-gradient(700px 420px at 15% 0%,rgba(226,139,168,.28),transparent 55%),
    radial-gradient(500px 380px at 100% 20%,rgba(201,180,224,.2),transparent 50%),
    var(--bg);
  padding:24px;
}
.card{
  width:min(360px,100%);
  background:rgba(255,251,252,.85);
  border:1px solid var(--line);
  border-radius:28px;
  padding:36px 28px 28px;
  box-shadow:0 20px 50px rgba(196,92,122,.1);
  backdrop-filter:blur(12px);
  text-align:center;
}
.orb{
  width:72px;height:72px;margin:0 auto 18px;border-radius:50%;
  background:radial-gradient(circle at 32% 28%,#FFE8F0,#E28BA8 55%,#C9B4E0);
  box-shadow:0 12px 28px rgba(196,92,122,.2);
}
h1{font-family:"Fraunces",Georgia,serif;font-size:26px;font-weight:600;letter-spacing:-.02em}
h1 span{color:var(--rose2);font-weight:500;font-size:.85em}
p{color:var(--soft);font-size:14px;margin:8px 0 22px;line-height:1.5}
form{display:flex;flex-direction:column;gap:10px}
input{
  padding:14px 16px;border-radius:16px;border:1px solid var(--line);
  background:#fff;color:var(--ink);font:inherit;font-size:15px;text-align:center;
  outline:none;transition:border .15s;
}
input:focus{border-color:var(--rose)}
button{
  padding:14px;border-radius:16px;border:0;cursor:pointer;
  background:linear-gradient(160deg,var(--rose),var(--rose2));
  color:#fff;font:inherit;font-size:15px;font-weight:600;
  box-shadow:0 10px 24px rgba(196,92,122,.28);
}
button:active{transform:scale(.98)}
.err{color:#D45B6A;font-size:13px;margin-top:12px}
</style>
<div class=card>
  <div class=orb></div>
  <h1>stev <span>· live</span></h1>
  <p>tempat aman buat ngobrol & curhat.<br>masukin kode yang Juan kasih ya.</p>
  <form method=POST action=/login>
    <input name=password type=password placeholder="kode masuk" autofocus required autocomplete=current-password>
    <button type=submit>masuk</button>
  </form>
  ${err ? `<p class=err>${err}</p>` : ''}
</div>`
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'POST' && url.pathname === '/login') {
    const raw = await readBody(req)
    const pw = new URLSearchParams(raw).get('password') || ''
    if (PASSWORD && pw === PASSWORD) {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': cookieHeader(req, TOKEN),
      })
      return res.end()
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(htmlLogin('kodenya kurang pas, coba lagi ya'))
  }

  if (url.pathname === '/logout') {
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': cookieHeader(req, '', 0),
    })
    return res.end()
  }

  if (!authed(req) && url.pathname !== '/login') {
    if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(htmlLogin())
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    if (!GEMINI_API_KEY) return json(res, 500, { error: 'GEMINI_API_KEY belum di-set' })
    try {
      const { systemInstruction, mode, memCount } = await buildStevPrompt()
      // ponytail: key dikirim ke browser setelah password. Cukup buat 1 user pribadi.
      // Upgrade ke ephemeral token (BidiGenerateContentConstrained) kalau nanti dibuka ke orang lain.
      return json(res, 200, {
        model: MODEL,
        voice: VOICE,
        systemInstruction,
        mode,
        memCount,
        apiKey: GEMINI_API_KEY,
        wsUrl: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`,
      })
    } catch (e) {
      console.error(e)
      return json(res, 500, { error: e.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/memory') {
    try {
      const { fact } = JSON.parse(await readBody(req))
      if (!fact || typeof fact !== 'string') return json(res, 400, { error: 'fact required' })
      const r = addMemory(fact.trim())
      return json(res, 200, r)
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // static
  let path = url.pathname === '/' ? '/index.html' : url.pathname
  if (path.includes('..')) {
    res.writeHead(400); return res.end('bad path')
  }
  const file = join(__dirname, 'public', path)
  if (!existsSync(file)) {
    res.writeHead(404); return res.end('not found')
  }
  const ext = file.split('.').pop()
  const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' }
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' })
  res.end(readFileSync(file))
})

server.listen(PORT, HOST, () => {
  console.log(`stev live → http://${HOST}:${PORT}`)
  console.log(`waai root → ${WAAI_ROOT}`)
  if (!PASSWORD) console.warn('LIVE_PASSWORD kosong — auth mati')
  if (!GEMINI_API_KEY) console.warn('GEMINI_API_KEY kosong')
})
