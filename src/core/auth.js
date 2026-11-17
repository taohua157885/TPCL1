/**
 * 微软正版登录（Xbox Live 设备码流程）
 *
 * 为什么用设备码而不是内嵌浏览器：
 *  - 不需要注册 Azure 应用、不需要 client secret，纯 HTTP 就能跑；
 *  - 用户在任意浏览器里输一次 8 位码即可，启动器不用塞 WebView2；
 *  - 拿到的 access_token 直接能换 Minecraft 的 JWT。
 *
 * 流程：device_code → live.com 轮询拿 RPS token → Xbox Live → XSTS → Minecraft
 */

const CLIENT_ID = '00000000402B5328'; // Xbox 官方公共客户端（设备码流程用）
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const TIMEOUT_MS = 20000;

async function req(url, init = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('请求超时')), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const text = await r.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: r.status, ok: r.ok, body };
  } finally {
    clearTimeout(t);
  }
}

const form = (obj) => new URLSearchParams(obj).toString();
const json = (obj) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(obj),
});

/** 第一步：申请设备码，用户在浏览器里输入 user_code */
export async function startDeviceCode() {
  // 微软这个端点只吃 POST（用 GET 会返回 "must be sent using the HTTP 'POST' method"）
  const r = await req('https://login.live.com/oauth20_connect.srf', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form({ client_id: CLIENT_ID, scope: SCOPE, response_type: 'device_code' }),
  });
  if (!r.body?.user_code) {
    throw new Error('获取登录码失败：' + JSON.stringify(r.body).slice(0, 300));
  }
  return {
    userCode: r.body.user_code,
    deviceCode: r.body.device_code,
    url: r.body.verification_uri || 'https://microsoft.com/link',
    expiresIn: r.body.expires_in ?? 900,
    interval: Math.max(3, r.body.interval ?? 5),
    message: r.body.message || '',
  };
}

/** 第二步：轮询换 RPS access_token */
export async function pollDeviceToken(deviceCode, interval = 5, onTick) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let wait = Math.max(3, interval) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    const r = await req('https://login.live.com/oauth20_token.srf', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const b = r.body || {};
    if (b.access_token) return b;
    if (b.error === 'authorization_pending') {
      onTick?.('等待你在浏览器里完成登录…');
      continue;
    }
    if (b.error === 'slow_down') {
      wait += 2000;
      continue;
    }
    if (b.error === 'expired_token') throw new Error('登录码已过期，请重新获取');
    if (b.error === 'authorization_declined') throw new Error('已取消登录');
    throw new Error('登录失败：' + (b.error_description || b.error || r.status));
  }
  throw new Error('登录超时（15 分钟）');
}

/** 第三步：RPS token → Xbox Live token */
async function xboxLive(accessToken) {
  const r = await req(
    'https://user.auth.xboxlive.com/user/authenticate',
    json({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${accessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
  );
  const tok = r.body?.Token;
  const uhs = r.body?.DisplayClaims?.xui?.[0]?.uhs;
  if (!tok || !uhs) throw new Error('Xbox Live 认证失败：' + JSON.stringify(r.body).slice(0, 300));
  return { token: tok, uhs };
}

/** 第四步：XSTS 授权 */
async function xsts(xblToken) {
  const r = await req(
    'https://xsts.auth.xboxlive.com/xsts/authorize',
    json({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }),
  );
  const tok = r.body?.Token;
  const uhs = r.body?.DisplayClaims?.xui?.[0]?.uhs;
  if (!tok || !uhs) {
    const xerr = r.body?.XErr;
    const hint =
      xerr === 2148916233
        ? '该微软账号还没有 Xbox 档案，请先去 xbox.com 创建'
        : xerr === 2148916235
          ? '该账号所在地区不支持 Xbox Live'
          : xerr === 2148916238
            ? '未成年账号需要先加入家庭组'
            : JSON.stringify(r.body).slice(0, 300);
    throw new Error('XSTS 授权失败：' + hint);
  }
  return { token: tok, uhs };
}

/** 第五步：换 Minecraft 令牌 */
export async function loginWithXbox(uhs, xstsToken) {
  const r = await req(
    'https://api.minecraftservices.com/authentication/login_with_xbox',
    json({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` }),
  );
  if (!r.body?.access_token) {
    throw new Error('获取 Minecraft 令牌失败：' + JSON.stringify(r.body).slice(0, 300));
  }
  return { accessToken: r.body.access_token, expiresIn: r.body.expires_in ?? 86400 };
}

/** 第六步：读档案（昵称 + UUID），没有档案说明没买过游戏 */
export async function fetchProfile(accessToken) {
  const r = await req('https://api.minecraftservices.com/minecraft/profile', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (r.status === 404) throw new Error('这个账号没有 Minecraft：Java 版的所有权');
  if (!r.body?.id) throw new Error('读取档案失败：' + JSON.stringify(r.body).slice(0, 200));
  return { uuid: r.body.id, name: r.body.name };
}

/** 一条龙：设备码已经拿到后，等用户完成 → 换出完整账号 */
export async function finishLogin(deviceCode, interval, onStep) {
  const rps = await pollDeviceToken(deviceCode, interval, (m) => onStep?.('poll', m));
  onStep?.('xbl', '正在登录 Xbox Live…');
  const xbl = await xboxLive(rps.access_token);
  onStep?.('xsts', '正在获取 XSTS 授权…');
  const st = await xsts(xbl.token);
  onStep?.('mc', '正在换取 Minecraft 令牌…');
  const mc = await loginWithXbox(xbl.uhs, st.token);
  onStep?.('profile', '正在读取游戏档案…');
  const prof = await fetchProfile(mc.accessToken);
  return {
    type: 'microsoft',
    name: prof.name,
    uuid: prof.uuid,
    accessToken: mc.accessToken,
    refreshToken: rps.refresh_token || '',
    obtainedAt: Date.now(),
    expiresAt: Date.now() + (mc.expiresIn || 86400) * 1000,
  };
}

/** 用 refresh_token 静默续期（启动时若快过期就调用） */
export async function refreshAccessToken(refreshToken) {
  const r = await req('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPE,
    }),
  });
  if (!r.body?.access_token) throw new Error('登录已过期，请重新登录微软账号');
  const xbl = await xboxLive(r.body.access_token);
  const st = await xsts(xbl.token);
  const mc = await loginWithXbox(xbl.uhs, st.token);
  const prof = await fetchProfile(mc.accessToken);
  return {
    type: 'microsoft',
    name: prof.name,
    uuid: prof.uuid,
    accessToken: mc.accessToken,
    refreshToken: r.body.refresh_token || refreshToken,
    obtainedAt: Date.now(),
    expiresAt: Date.now() + (mc.expiresIn || 86400) * 1000,
  };
}
