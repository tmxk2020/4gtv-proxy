// api/handler.js
// Vercel Functions (Edge Runtime) 版本，从 Cloudflare Worker 版移植。
// 逻辑完全一致：算每日动态Auth -> 请求4gtv接口 -> 按路由规则取目标URL
// -> 302跳转给播放器。
//
// 【为什么从Workers换到Vercel】4gtv的API本身也架在Cloudflare后面，
// Cloudflare Workers发起的fetch()请求会被自动打上"这是Workers发出的"
// 标记(cf-worker请求头)，4gtv大概率专门用WAF规则拦截这个标记——这是
// 很多挂在CF上的内容方反制"白嫖Workers当跳转代理"的常见手段。Vercel
// 的边缘网络跑在AWS上，不会带这个CF专属标记，理论上能绕开这条针对性
// 拦截。但AWS的IP段本身也是公开的，如果对方WAF是更粗暴地拦所有已知
// 云服务商IP，这个方案可能还是不行——只能部署后实测。

export const config = { runtime: 'edge' };

// 接口地址
const API_URL_1 = "https://api2.4gtv.tv/TV/GetChannelUrl";
const API_URL_2 = "https://api2.4gtv.tv/App/GetChannelUrl2";

// 明文 header_key
const PLAIN_KEY = "7F3DD6981A72707B12A8C0CC80A3C96B75B9057AD55F1AE1";

// 路由二不替换 1080 的频道列表
const NO_REPLACE_CHANNELS = new Set([78, 490, 114, 79, 80, 93, 501, 57, 123, 172, 38, 445, 25, 40, 9, 94, 179]);

// 路由二直接取第一个地址的频道（仅57）
const FIRST_URL_CHANNELS = new Set([57]);

// 内存缓存（同一个执行实例生命周期内有效，效果跟CF Worker版一样是
// "尽力而为"的缓存，不保证跨实例持久，不需要持久化就不用额外接数据库）
const CACHE = new Map();

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

    // 【实验性】mytvsuper那边的经验：如果目标服务是靠读取
    // X-Forwarded-For（客户端自己能随便编的头）来判断"你是不是本地IP"，
    // 而不是真正校验TCP连接的来源IP，伪造这个头就能绕过地域限制。
    // 4gtv这边未经验证，值得低成本试一次——如果没用（大概率是Cloudflare
    // 自己的WAF在拦，那层只认真实连接IP，伪造头无效），就把这行删掉，
    // 回到"跑在N1本地"这条路。
    // 下面这个IP只是示例（台湾中华电信/HiNet常见IP段），建议自己多换
    // 几个真实台湾IP段测试，不保证一定有效。
    const FAKE_CLIENT_IP = '210.6.4.148'; // 中华电信(HiNet)常见IP段示例，可自行更换测试

    const headers = {
        "Host": "api2.4gtv.tv",
        "fsDEVICE": "TV",
        "fsVERSION": "1.5.4",
        "Content-Type": "application/json",
        "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 13; Android TV Build/TP1A.220624.014)",
        "4GTV_AUTH": authHeader,
        "X-Forwarded-For": FAKE_CLIENT_IP,
        "X-Real-IP": FAKE_CLIENT_IP
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

        // 【诊断用，先保留】跟CF Worker那版一样，先把上游真实状态码和
        // 内容暴露出来，方便确认Vercel这条路到底通不通。确认没问题后
        // 可以把这段简化成 "Upstream API Error"。
        if (!resp.ok) {
            const bodyText = await resp.text();
            return new Response(
                `诊断信息(Vercel):\n` +
                `上游HTTP状态码: ${resp.status} ${resp.statusText}\n` +
                `请求URL: ${api_url}\n` +
                `伪造的X-Forwarded-For: ${FAKE_CLIENT_IP}\n` +
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
