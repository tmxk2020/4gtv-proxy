// ============ 4gtv Vercel Edge 终极版 (绕开 CF 封禁) ============
export const config = { runtime: 'edge' };

const API = "https://api2.4gtv.tv";
const AES_KEY = "ilyB29ZdruuQjC45JhBBR7o2Z8WJ26Vg";
const AES_IV  = "JUMxvVMmszqUTeKn";
const FALLBACK_PLAIN = "7F3DD6981A72707B12A8C0CC80A3C96B75B9057AD55F1AE1";
const FS_ENC_KEY = "55E9B326-21FA-45E8-8FA8-5C361729A888";
const NO_REPLACE = new Set([78,490,114,79,80,93,501,57,123,172,38,445,25,40,9,94,179]);

const SECRET = "tmxk4gtv2026"; 

const FALLBACK_CHANNELS = {
    "1": "4gtv-4gtv003", "2": "4gtv-4gtv004", "3": "4gtv-4gtv005", "31": "4gtv-4gtv040",
    "183": "4gtv-4gtv012", "291": "4gtv-4gtv013", "4": "4gtv-4gtv006", "6": "4gtv-4gtv008",
    "209": "4gtv-4gtv010", "107": "4gtv-4gtv014"
};

const CACHE = new Map();
const JAR = new Map();
const enc = s => new TextEncoder().encode(s);
const cGet = k => { const v = CACHE.get(k); return (v && Date.now() < v.exp) ? v.val : null; };
const cSet = (k, val, ttl) => CACHE.set(k, { val, exp: Date.now() + ttl * 1000 });

const UA_IOS = "%E5%9B%9B%E5%AD%A3%E7%B7%9A%E4%B8%8A/1 CFNetwork/1399 Darwin/22.1.0";
const UA_ANDROID = "Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TQ3A.230805.001)";

function cookieHeader() { return JAR.size ? [...JAR.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : null; }
function absorbCookies(resp) {
  let sc = [];
  try { if (resp.headers.getSetCookie) sc = resp.headers.getSetCookie(); } catch (e) {}
  for (const c of sc) {
    const nv = c.split(";")[0]; const i = nv.indexOf("=");
    if (i > 0) JAR.set(nv.slice(0, i).trim(), nv.slice(i + 1).trim());
  }
}
async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const ck = cookieHeader(); if (ck) headers["Cookie"] = ck;
  const resp = await fetch(url, { ...opts, headers });
  absorbCookies(resp); return resp;
}

async function getPlainKey() {
  const hit = cGet("plain"); if (hit) return hit;
  const resp = await apiFetch(API + "/App/GetAPPConfig", {
    method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8", "fsdevice": "iOS", "fsversion": "3.1.0", "fsenc_key": FS_ENC_KEY, "fsvalue": "", "User-Agent": UA_IOS },
    body: JSON.stringify({ fsDEVICE: "iOS", fsVERSION: "3.1.0" })
  });
  if (!resp.ok) return FALLBACK_PLAIN;
  const j = await resp.json().catch(() => ({})); const hk = j?.Data?.header_key; if (!hk) return FALLBACK_PLAIN;
  try {
    const key = await crypto.subtle.importKey("raw", enc(AES_KEY), { name: "AES-CBC" }, false, ["decrypt"]);
    const raw = Uint8Array.from(atob(hk), c => c.charCodeAt(0));
    const plain = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv: enc(AES_IV) }, key, raw));
    cSet("plain", plain, 6 * 3600); return plain;
  } catch (e) { return FALLBACK_PLAIN; }
}
async function getAuth() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const buf = await crypto.subtle.digest("SHA-512", enc(day + await getPlainKey()));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

const pick = (o, ks) => { for (const k of ks) if (o[k] != null && o[k] !== "") return o[k]; return null; };
async function getChannels() {
  const hit = cGet("chs"); if (hit) return hit;
  const resp = await apiFetch(API + "/Channel/GetAllChannel/mobile/L", {
    headers: { "Content-Type": "application/json; charset=UTF-8", "fsDEVICE": "Android", "fsVERSION": "2.3.8", "fsENC_KEY": FS_ENC_KEY, "User-Agent": UA_ANDROID, "4GTV_AUTH": await getAuth() }
  });
  const j = await resp.json().catch(() => ({})); const arr = Array.isArray(j?.Data) ? j.Data : [];
  let list = arr.map(it => ({ id: String(pick(it, ["fnID"])), asset: pick(it, ["fs4GTV_ID"]), name: pick(it, ["fsNAME"]) || "4gtv", logo: pick(it, ["fsLOGO_MOBILE"]) || "", group: pick(it, ["fsTYPE_NAME"]) || "4gtv", no: pick(it, ["fnCHANNEL_NO"]) || 9999 })).filter(c => c.id && c.asset);
  const seenNames = new Set(); const uniq = list.filter(c => { const n = c.name.trim(); if (seenNames.has(n)) return false; seenNames.add(n); return true; });
  uniq.sort((a, b) => (a.no || 9999) - (b.no || 9999));
  if (uniq.length) cSet("chs", uniq, 12 * 3600); return uniq;
}

async function getStreamUrl(chId, asset) {
  const ck = `url_${chId}_${asset}`; const hit = cGet(ck); if (hit) return hit;
  if (!asset) { const list = await getChannels(); asset = list.find(c => String(c.id) === String(chId))?.asset || FALLBACK_CHANNELS[String(chId)]; }
  if (!asset) throw new Error(`找不到频道${chId}的资产ID`);

  const strategies = [
    { hd: { "fsDEVICE": "iOS", "fsversion": "3.1.0", "User-Agent": UA_IOS }, bodyType: "mobile", idType: "string" },
    { hd: { "fsDEVICE": "Android", "fsVERSION": "2.3.8", "User-Agent": UA_ANDROID }, bodyType: "mobile", idType: "string" },
    { hd: { "fsDEVICE": "TV", "fsVERSION": "1.5.4", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, bodyType: "tv", idType: "string" }
  ];

  let lastErr = "";
  for (const s of strategies) {
    const payload = {
      "fsASSET_ID": asset,
      "fnCHANNEL_ID": s.idType === "string" ? String(chId) : Number(chId),
      "clsAPP_IDENTITY_VALIDATE_ARUS": { "fsVALUE": "", "fsENC_KEY": FS_ENC_KEY },
      "fsDEVICE_TYPE": s.bodyType
    };
    try {
      const resp = await apiFetch(API + "/App/GetChannelUrl2", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8", "fsENC_KEY": FS_ENC_KEY, "4GTV_AUTH": await getAuth(), ...s.hd },
        body: JSON.stringify(payload)
      });
      const text = await resp.text();
      if (text.trim().startsWith("<")) continue; 
      const j = JSON.parse(text);
      const urls = j?.Data?.flstURLs || [];
      if (urls.length > 0) {
        let target = urls.find(u => u.includes("-mozai.4gtv.tv"));
        if (target) target = NO_REPLACE.has(Number(chId)) ? target : target.replace("index.m3u8", "1080.m3u8");
        else target = urls[urls.length - 1];
        cSet(ck, target, 15 * 60); return target;
      }
      lastErr = `Err:${j?.ErrMessage || "unknown"}`;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(`取流失败 (${lastErr})`);
}

// Vercel 核心入口
export default async function handler(request) {
  const u = new URL(request.url); const host = u.origin;
  const txt = (s, code) => new Response(s, { status: code || 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (u.searchParams.get("k") !== SECRET) return new Response("Not Found", { status: 404 });
  try {
    if (u.pathname === "/" && !u.searchParams.has("id")) {
      const list = await getChannels();
      let m = "#EXTM3U\n";
      let m3uList = list.length > 0 ? list : Object.keys(FALLBACK_CHANNELS).map(id => ({ id, name: "保底" + id, no: id, asset: FALLBACK_CHANNELS[id], logo: "", group: "4gtv" }));
      for (const c of m3uList) m += `#EXTINF:-1 tvg-chno="${c.no}" tvg-id="${c.id}" tvg-name="${c.name}" tvg-logo="${c.logo}" group-title="${c.group}",${c.name}\n${host}/?id=${c.id}&k=${SECRET}\n`;
      return txt(m);
    }
    const chId = u.searchParams.get("id"); if (!chId) return txt("用法: /?id=频道号&k=密钥", 400);
    return Response.redirect(await getStreamUrl(chId, null), 302);
  } catch (e) { return txt("Vercel错误: " + e.message, 502); }
}
