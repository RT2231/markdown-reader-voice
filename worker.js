/**
 * 読み上げリーダー — Cloudflare Worker
 * ------------------------------------------------------------
 * このWorkerは「読み上げリーダー」アプリ全利用者が共有する、単一の固定エンドポイントです。
 * 利用者側で個別にWorkerを用意する必要はありません（開発者が1つだけデプロイして運用します）。
 *
 * 役割:
 *   1. /api/tts        ElevenLabs Text-to-Speech を安全に呼び出す（APIキーはこのWorker内の
 *                       シークレットにのみ保存し、ブラウザには一切渡さない）
 *   2. /api/voices      ElevenLabs のボイス一覧を取得する
 *   3. /api/fetch-url   外部URLのMarkdownをサーバー側で取得し、CORSを回避する
 *
 * デプロイ方法（Cloudflareダッシュボードのみで完結・1回だけ実施）:
 *   1. Cloudflareダッシュボード → Workers & Pages → 「Workers を作成する」
 *   2. 適当な名前（例: markdown-reader-voice-api）で作成し、エディタにこのファイルの
 *      中身を貼り付けて保存・デプロイ
 *   3. 作成したWorkerの「設定」→「変数とシークレット」で以下を追加:
 *        - 名前: ELEVENLABS_API_KEY   値: あなたのElevenLabs APIキー   種別: シークレット
 *        - （推奨）名前: ALLOWED_ORIGIN  値: アプリを公開しているオリジン
 *          （例: https://your-name.github.io）種別: 変数
 *          未設定の場合、どのWebサイトからでも呼び出せてしまうため設定を強く推奨します。
 *   4. 「設定」→「トリガー」に表示されている Worker の URL をコピーし、
 *      index.html 内の `const WORKER_URL = "..."` にその値を貼り付けてから配信してください
 *      （利用者が各自で入力する項目ではなく、アプリ側に固定で埋め込む値です）。
 *
 * 本Workerのコード自体はCloudflareダッシュボードのエディタに貼り付けるだけで動作し、
 * KVやD1などの追加サービスは使用していません（レート制限も行っていません）。
 *
 * ---------------------------------------------------------------
 * セキュリティについて（重要・必ずお読みください）
 * ---------------------------------------------------------------
 * このWorkerは全利用者が共有する公開エンドポイントとして運用されるため、以下の前提を
 * ご理解のうえ運用してください。
 *
 * ・ALLOWED_ORIGIN を設定していても、それはブラウザ経由のCORSリクエストを制限するだけで、
 *   curl等でWorker URLに直接リクエストを送る行為までは防げません。個人・API利用のレート制限は
 *   行っていないため、Worker URLが広く知られると、あなたのElevenLabs APIキーの利用量（＝費用）が
 *   想定より増える可能性があります。ElevenLabs側の利用量アラート・上限設定を合わせて
 *   有効にしておくことを推奨します。
 * ・/api/fetch-url はSSRF対策として、localhostやプライベートIP宛のURLを拒否します。
 * ・すべての外部リクエストにはタイムアウト（10秒）と、取得できるサイズの上限（2MB）を設けています。
 */

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
const FETCH_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB — this proxy is meant for markdown documents, not large files
const MAX_TTS_TEXT_LENGTH = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowOrigin = env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN.length ? env.ALLOWED_ORIGIN : "*";

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname === "/api/voices" && request.method === "GET") {
        return await handleVoices(env, corsHeaders);
      }
      if (url.pathname === "/api/tts" && request.method === "POST") {
        return await handleTts(request, env, corsHeaders);
      }
      if (url.pathname === "/api/fetch-url" && request.method === "GET") {
        return await handleFetchUrl(url, corsHeaders);
      }
      return new Response("Not found", { status: 404, headers: corsHeaders });
    } catch (err) {
      return json({ error: "Worker error: " + err.message }, 500, corsHeaders);
    }
  },
};

/* ---------------- fetch with timeout + size cap ---------------- */
async function safeFetch(input, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyWithLimit(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel();
      throw new Error(`Response too large (limit ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
  return buf;
}

/* ---------------- SSRF guard for /api/fetch-url ---------------- */
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0") return true;

  // IPv4 literal checks
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                            // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16
    if (a === 169 && b === 254) return true;               // link-local / cloud metadata
    if (a === 0) return true;
    return false;
  }

  // IPv6 literal checks (loopback, link-local, unique-local)
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;

  return false;
}

async function handleFetchUrl(url, corsHeaders) {
  const target = url.searchParams.get("url");
  if (!target) {
    return json({ error: "url query parameter is required" }, 400, corsHeaders);
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return json({ error: "Invalid URL" }, 400, corsHeaders);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return json({ error: "Only http/https URLs are allowed" }, 400, corsHeaders);
  }
  if (isBlockedHost(parsed.hostname)) {
    return json({ error: "This host is not allowed" }, 400, corsHeaders);
  }

  let res;
  try {
    res = await safeFetch(parsed.toString(), {
      headers: { "User-Agent": "markdown-reader-voice-worker/1.0" },
      redirect: "follow",
    });
  } catch (err) {
    const msg = err.name === "AbortError" ? "Request timed out" : err.message;
    return json({ error: `Fetch failed: ${msg}` }, 502, corsHeaders);
  }
  if (!res.ok) {
    return json({ error: `Fetch failed with status ${res.status}` }, res.status, corsHeaders);
  }

  let bytes;
  try {
    bytes = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
  } catch (err) {
    return json({ error: err.message }, 413, corsHeaders);
  }
  const text = new TextDecoder("utf-8").decode(bytes);

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(text, { status: 200, headers });
}

/* ---------------- ElevenLabs proxy ---------------- */
async function handleVoices(env, corsHeaders) {
  if (!env.ELEVENLABS_API_KEY) {
    return json({ error: "ELEVENLABS_API_KEY is not configured on this Worker" }, 500, corsHeaders);
  }
  let res;
  try {
    res = await safeFetch(`${ELEVENLABS_API_BASE}/v1/voices`, {
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    });
  } catch (err) {
    return json({ error: "Failed to reach ElevenLabs: " + err.message }, 502, corsHeaders);
  }
  if (!res.ok) {
    return json({ error: `ElevenLabs error ${res.status}` }, res.status, corsHeaders);
  }
  const data = await res.json();
  return json({ voices: (data.voices || []).map(v => ({ voice_id: v.voice_id, name: v.name })) }, 200, corsHeaders);
}

async function handleTts(request, env, corsHeaders) {
  if (!env.ELEVENLABS_API_KEY) {
    return json({ error: "ELEVENLABS_API_KEY is not configured on this Worker" }, 500, corsHeaders);
  }

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength && contentLength > 64 * 1024) {
    return json({ error: "Request body too large" }, 413, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }
  const { text, voiceId, modelId } = body || {};
  if (!text || typeof text !== "string" || !text.trim()) {
    return json({ error: "text is required" }, 400, corsHeaders);
  }
  if (!voiceId || typeof voiceId !== "string" || !/^[A-Za-z0-9_-]+$/.test(voiceId)) {
    return json({ error: "voiceId is required and must be a valid ElevenLabs voice id" }, 400, corsHeaders);
  }
  const allowedModels = ["eleven_multilingual_v2", "eleven_turbo_v2_5"];
  const safeModelId = allowedModels.includes(modelId) ? modelId : "eleven_multilingual_v2";

  let res;
  try {
    res = await safeFetch(`${ELEVENLABS_API_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text: text.slice(0, MAX_TTS_TEXT_LENGTH),
        model_id: safeModelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (err) {
    const msg = err.name === "AbortError" ? "Request timed out" : err.message;
    return json({ error: "Failed to reach ElevenLabs: " + msg }, 502, corsHeaders);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return json({ error: `ElevenLabs error ${res.status}: ${errText.slice(0, 300)}` }, res.status, corsHeaders);
  }

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "audio/mpeg");
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: 200, headers });
}

function json(obj, status, corsHeaders) {
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers });
}
