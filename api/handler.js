// api/handler.js
// Vercel Functions (Edge Runtime) 优化版

export const config = { runtime: 'edge' };

// 接口地址
const API_URL_1 = "https://api2.4gtv.tv/TV/GetChannelUrl";
const API_URL_2 = "https://api2.4gtv.tv/App/GetChannelUrl2";

// 明文 header_key (如果失效，需重新抓包获取)
const PLAIN_KEY = "7F3DD6981A72707B12A8C0CC80A3C96B75B9057AD55F1AE1";

// 路由二不替换 1080 的频道列表
const NO_REPLACE_CHANNELS = new Set([78, 490, 114, 79, 80, 93, 501, 57, 123, 172, 38, 445, 25, 40, 9, 94, 179]);
// 路由二直接取第一个地址的频道（仅57）
const FIRST_URL_CHANNELS = new Set([57]);

// 内存缓存
const CACHE = new Map();

// 【优化 1】真实的台湾 IP 池 (中华电信 HiNet, 远传, 台湾大哥大等)
const TW_IP_POOL = [
    '1.160.12.34', '1.161.56.78', '1.162.100.10', '1.163.50.50',
    '36.224.10.20', '36.225.15.15', '36.230.100.100', '36.231.50.50',
    '60.248.50.50', '60.249.12.34', '60.250.15.15', '60.251.100.10',
    '114.24.12.34', '114.25.56.78', '114.32.56.78', '114.36.100.10',
    '168.95.1.10', '168.95.2.20', '168.95.3.30', '168.95.4.40',
    '218.161.5.5', '218.164.10.10', '218.165.20.20', '218.166.30.30'
];

async function getAuth() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const today = `${year}${month}${day}`;

    const text = today + PLAIN_KEY;
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-512", data);

    let binary = "";
    const bytes = new Uint8Array(hashBuffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export default async function handler(request) {
    const urlObj = new URL(request.url);
    const path = urlObj.pathname.replace(/^\/+/, "");

    if (!path) {
        return new Response("Params error: use /[2/]fnCHANNEL_ID&fsASSET_ID", { status: 400 });
    }

    let api_url = API_URL_1;
    let cache_ttl = 4 * 3600;
    let use_mozai = false;
    let params = path;

    if (path.startsWith("2/")) {
        api_url = API_URL_2;
        cache_ttl = 15 * 60;
        params = path.replace(/^2\//, "");
        use_mozai = true;
    }

    if (!params.includes("&")) {
        return new Response("Params error: use /[2/]fnCHANNEL_ID&fsASSET_ID", { status: 400 });
    }

    const [ch_id, asset_id] = params.split("&", 2);
    const ch_num = parseInt(ch_id, 10);
    if (isNaN(ch_num)) {
        return new Response("First param must be number", { status: 400 });
    }

    const cache_key = `${api_url}_${ch_id}_${asset_id}`;
    const cached = CACHE.get(cache_key);
    if (cached && Date.now() < cached.expire) {
        return Response.redirect(cached.url, 302);
    }

    const authHeader = await getAuth();

    // 随机抽取一个真实的台湾 IP
    const FAKE_CLIENT_IP = TW_IP_POOL[Math.floor(Math.random() * TW_IP_POOL.length)];

    // 【优化 2】补全更逼真的 Android TV 客户端请求头
    const headers = {
        "Host": "api2.4gtv.tv",
        "fsDEVICE": "TV",
        "fsVERSION": "1.5.4", // 如果有更新版本可尝试修改
        "Content-Type": "application/json",
        // 模拟 Sony Bravia 4K Android TV
        "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 12; BRAVIA 4K Build/STTL.B.0.1.0)",
        "4GTV_AUTH": authHeader,
        "X-Forwarded-For": FAKE_CLIENT_IP,
        "X-Real-IP": FAKE_CLIENT_IP,
        "Client-IP": FAKE_CLIENT_IP,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin": "https://www.4gtv.tv",
        "Referer": "https://www.4gtv.tv/",
        "Connection": "keep-alive"
    };

    const payload = {
        "fnCHANNEL_ID": ch_num,
        "fsASSET_ID": asset_id,
        "fsDEVICE_TYPE": "tv",
        "clsAPP_IDENTITY_VALIDATE_ARUS": {
            "fsVALUE": ""
        }
    };

    try {
        const resp = await fetch(api_url, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (!resp.ok) {
            const bodyText = await resp.text();
            return new Response(
                `诊断信息(Vercel):\n` +
                `上游HTTP状态码: ${resp.status} ${resp.statusText}\n` +
                `请求URL: ${api_url}\n` +
                `当前使用的伪装IP: ${FAKE_CLIENT_IP}\n` +
                `4GTV_AUTH: ${authHeader}\n` +
                `上游响应内容(前1000字符):\n${bodyText.slice(0, 1000)}\n`,
                { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } }
            );
        }

        const resJson = await resp.json();
        const urls = resJson?.Data?.flstURLs || [];

        let target_url = null;

        if (use_mozai) {
            if (ch_num === 57) {
                if (urls.length === 0) return new Response("No URLs returned", { status: 500 });
                target_url = urls[0];
            } else {
                for (const u of urls) {
                    if (u.includes("-mozai.4gtv.tv")) {
                        if (NO_REPLACE_CHANNELS.has(ch_num)) {
                            target_url = u;
                        } else {
                            target_url = u.replace("index.m3u8", "1080.m3u8");
                        }
                        break;
                    }
                }
            }
        } else {
            if (urls.length < 3) {
                return new Response(
                    `诊断信息: URL数量不足，期望>=3个，实际返回:\n${JSON.stringify(resJson, null, 2).slice(0, 1500)}\n`,
                    { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } }
                );
            }
            target_url = urls[2];
        }

        if (!target_url) {
            return new Response("No valid target URL found", { status: 500 });
        }

        CACHE.set(cache_key, {
            url: target_url,
            expire: Date.now() + cache_ttl * 1000
        });

        return Response.redirect(target_url, 302);

    } catch (err) {
        return new Response("Internal Server Error: " + err.message, { status: 500 });
    }
}
