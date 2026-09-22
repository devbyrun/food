/**
 * LINE Authentication Service (OAuth 2.0 & LIFF & OpenID Connect)
 */
require('dotenv').config();

const LINE_AUTH_ENDPOINT = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN_ENDPOINT = 'https://api.line.me/oauth2/v2.1/token';
const LINE_PROFILE_ENDPOINT = 'https://api.line.me/v2/profile';
const LINE_VERIFY_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify';

function getLineCredentials() {
  return {
    channelId: process.env.LINE_CHANNEL_ID || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
    callbackUrl: process.env.LINE_CALLBACK_URL || '',
    liffId: process.env.LINE_LIFF_ID || '',
  };
}

function isLineConfigured() {
  const { channelId, channelSecret } = getLineCredentials();
  return Boolean(channelId && channelSecret);
}

function getCallbackUrl(req, customRedirect) {
  if (customRedirect) return customRedirect;

  if (req) {
    const host = req.headers['x-forwarded-host'] || req.get('host') || '';
    const protocol = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
      return `http://${host}/api/auth/line/callback`;
    }
    if (host) {
      return `${protocol}://${host}/api/auth/line/callback`;
    }
  }

  const { callbackUrl } = getLineCredentials();
  if (callbackUrl) return callbackUrl;
  return 'https://food.rundev.site/api/auth/line/callback';
}

function getAuthorizationUrl(req, state = 'foodpos_state', customRedirect = '') {
  const { channelId } = getLineCredentials();
  const redirectUri = getCallbackUrl(req, customRedirect);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: channelId,
    redirect_uri: redirectUri,
    state: state,
    scope: 'profile openid email',
    prompt: 'consent',
  });

  return `${LINE_AUTH_ENDPOINT}?${params.toString()}`;
}

async function exchangeCodeForToken(code, req, customRedirect = '') {
  const { channelId, channelSecret } = getLineCredentials();
  const redirectUri = getCallbackUrl(req, customRedirect);

  const bodyParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri,
    client_id: channelId,
    client_secret: channelSecret,
  });

  const response = await fetch(LINE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: bodyParams.toString(),
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.error || 'Failed to exchange LINE authorization code');
  }

  return data; // { access_token, token_type, expires_in, refresh_token, scope, id_token }
}

async function getLineProfile(accessToken) {
  const response = await fetch(LINE_PROFILE_ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json();
  if (!response.ok || data.message) {
    throw new Error(data.message || 'Failed to fetch LINE user profile');
  }

  return {
    userId: data.userId,
    displayName: data.displayName,
    pictureUrl: data.pictureUrl || null,
    statusMessage: data.statusMessage || null,
  };
}

async function verifyIdToken(idToken) {
  const { channelId } = getLineCredentials();
  if (!idToken || !channelId) return null;

  try {
    const bodyParams = new URLSearchParams({
      id_token: idToken,
      client_id: channelId,
    });

    const response = await fetch(LINE_VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams.toString(),
    });

    if (response.ok) {
      return await response.json(); // contains email, name, picture, sub
    }
  } catch (err) {
    console.warn('[LINE Verify ID Token warning]:', err.message);
  }
  return null;
}

module.exports = {
  getLineCredentials,
  isLineConfigured,
  getCallbackUrl,
  getAuthorizationUrl,
  exchangeCodeForToken,
  getLineProfile,
  verifyIdToken,
};
