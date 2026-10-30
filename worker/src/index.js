const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const MAX_BODY_BYTES = 8192;
const IV_BYTES = 12;
const ADDITIONAL_DATA = new TextEncoder().encode('chronos-session-v1');

const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

function sessionKey(env) {
  return crypto.subtle.importKey('raw', fromBase64(env.SESSION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// The refresh token leaves this Worker only inside this blob. Nothing is stored here.
async function seal(env, refreshToken) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(refreshToken);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ADDITIONAL_DATA }, await sessionKey(env), data);
  return toBase64Url(new Uint8Array([...iv, ...new Uint8Array(cipher)]));
}

async function open(env, session) {
  try {
    const bytes = fromBase64(session);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: ADDITIONAL_DATA },
      await sessionKey(env),
      bytes.slice(IV_BYTES),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).includes(origin) ? origin : null;
}

function respond(status, body, origin) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function postForm(url, fields) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

async function exchangeCode(env, code, origin) {
  const fields = {
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: 'authorization_code',
  };
  // Google documents the page origin for popup codes; older clients expect "postmessage".
  let res = await postForm(TOKEN_URL, { ...fields, redirect_uri: origin });
  let data = await res.json();
  if (data.error === 'redirect_uri_mismatch') {
    res = await postForm(TOKEN_URL, { ...fields, redirect_uri: 'postmessage' });
    data = await res.json();
  }
  return res.ok ? data : null;
}

async function handleExchange(env, body, origin) {
  if (typeof body?.code !== 'string') return respond(400, { error: 'bad_request' }, origin);

  const tokens = await exchangeCode(env, body.code, origin);
  if (!tokens) return respond(401, { error: 'reauth' }, origin);

  // Google omits the refresh token on repeat grants. Revoking resets consent, so the next try gets one.
  if (!tokens.refresh_token) {
    await postForm(REVOKE_URL, { token: tokens.access_token });
    return respond(409, { error: 'retry' }, origin);
  }

  const profile = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!profile.ok) return respond(502, { error: 'upstream' }, origin);
  const { email } = await profile.json();

  return respond(200, {
    email,
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
    scope: tokens.scope,
    session: await seal(env, tokens.refresh_token),
  }, origin);
}

async function handleRefresh(env, body, origin) {
  const refreshToken = typeof body?.session === 'string' ? await open(env, body.session) : null;
  if (!refreshToken) return respond(401, { error: 'reauth' }, origin);

  const res = await postForm(TOKEN_URL, {
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const data = await res.json();
  if (data.error === 'invalid_grant') return respond(401, { error: 'reauth' }, origin);
  if (!res.ok) return respond(502, { error: 'upstream' }, origin);
  return respond(200, { access_token: data.access_token, expires_in: data.expires_in }, origin);
}

async function handleRevoke(env, body, origin) {
  const refreshToken = typeof body?.session === 'string' ? await open(env, body.session) : null;
  if (refreshToken) await postForm(REVOKE_URL, { token: refreshToken });
  return respond(204, null, origin);
}

const ROUTES = {
  '/auth/exchange': handleExchange,
  '/auth/refresh': handleRefresh,
  '/auth/revoke': handleRevoke,
};

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const handler = ROUTES[new URL(request.url).pathname];

    if (!origin) return respond(403, { error: 'forbidden' }, null);
    if (!handler) return respond(404, { error: 'not_found' }, origin);

    if (request.method === 'OPTIONS') {
      const preflight = respond(204, null, origin);
      preflight.headers.set('Access-Control-Allow-Methods', 'POST');
      preflight.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
      preflight.headers.set('Access-Control-Max-Age', '86400');
      return preflight;
    }

    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, origin);
    if (request.headers.get('X-Requested-With') !== 'XmlHttpRequest') return respond(403, { error: 'forbidden' }, origin);

    const { success } = await env.LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return respond(429, { error: 'rate_limited' }, origin);

    const body = await readJson(request);
    if (!body) return respond(400, { error: 'bad_request' }, origin);
    return handler(env, body, origin);
  },
};
