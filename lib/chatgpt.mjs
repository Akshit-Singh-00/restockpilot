import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, assert } from './domain.mjs';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function verifyChatGPTIdentity(token, clientId, nonce, keys) {
  const { payload } = await jwtVerify(token, keys, { issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'nonce'] });
  assert(payload.nonce === nonce && typeof payload.sub === 'string', 'ChatGPT identity did not match this sign-in.', 400);
  return payload;
}

// Credentials live only in this server process. Disk holds host/registration IDs
// and display information, never access, refresh, or ID tokens.
export class ChatGPTConnection {
  constructor(dataDir, { fetcher = fetch, verifier } = {}) {
    this.file = resolve(dataDir, 'chatgpt-registrations.json');
    this.fetcher = fetcher;
    this.verifier = verifier;
    this.pending = null;
    this.session = null;
    this.refreshing = null;
    this.modelsCache = null;
  }
  async init() {
    try { this.saved = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.saved = { hostId: `urn:uuid:${randomUUID()}`, profiles: [] };
      await this.save();
    }
    return this;
  }
  async save() {
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }
  state() {
    return {
      connected: Boolean(this.session), sharing: Boolean(this.session?.sharing),
      profileId: this.session?.profile.id || null,
      profiles: this.saved.profiles.map(({ id, label }) => ({ id, label })),
      memoryOnly: true
    };
  }
  async request(url, options = {}) {
    let response;
    try { response = await this.fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new AppError('ChatGPT could not be reached. Check your connection and try again.', 502); }
    if (response.status === 429) throw new AppError('ChatGPT usage limit reached. Review your plan and RestockPilot limit in Manage usage. No paid API fallback was used.', 429);
    if (!response.ok) throw new AppError(`ChatGPT returned HTTP ${response.status}. Reconnect your account or check Manage usage.`, 502);
    return response;
  }
  async discovery() {
    if (!this.metadata) {
      const metadata = await (await this.request(`${issuer}/.well-known/openid-configuration`)).json();
      assert(metadata.issuer === issuer, 'Unexpected ChatGPT identity provider.', 502);
      for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
        assert(typeof metadata[field] === 'string' && new URL(metadata[field]).origin === issuer, 'Unexpected ChatGPT authorization endpoint.', 502);
      }
      this.metadata = metadata;
    }
    return this.metadata;
  }
  async begin(port, profileId) {
    const profile = profileId ? this.saved.profiles.find(row => row.id === profileId) : null;
    assert(!profileId || profile, 'Select an existing account or Add account.');
    const metadata = await this.discovery();
    const pending = { state: random(), nonce: random(), verifier: random(), browser: random(),
      redirect: `http://127.0.0.1:${port}/auth/callback`, profile, expires: Date.now() + 10 * 60 * 1000 };
    const url = new URL(metadata.authorization_endpoint);
    const params = { client_id: profile?.clientId || 'dynamic_agent_client', ext_agent_host_id: this.saved.hostId,
      response_type: 'code', redirect_uri: pending.redirect, scope: scopes, resource,
      state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url') };
    if (!profile) params.agent_name_hint = 'RestockPilot';
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    this.pending = pending;
    return { url: url.href, cookie: pending.browser };
  }
  async callback(params, browserCookie) {
    const pending = this.pending;
    assert(pending && pending.expires > Date.now() && equal(params.get('state'), pending.state) && equal(browserCookie, pending.browser), 'Sign-in expired or did not match this browser. Return to RestockPilot and start again.', 400);
    this.pending = null; // Consume once, including denied or failed attempts.
    assert(!params.has('error'), 'ChatGPT connection was not authorized. You can try again from RestockPilot.', 400);
    const code = params.get('code');
    assert(code && code.length < 8192, 'Missing sign-in code.', 400);
    const clientId = params.get('client_id') || pending.profile?.clientId;
    assert(typeof clientId === 'string' && /^oaiapp_[A-Za-z0-9_-]+$/.test(clientId), 'ChatGPT did not return a registered client ID.', 400);
    assert(!pending.profile || clientId === pending.profile.clientId, 'The returned registration does not match the selected account.', 400);
    // Retain an issued registration even when its short-lived code exchange fails.
    let profile = pending.profile || this.saved.profiles.find(row => row.clientId === clientId);
    if (!profile) {
      profile = { id: randomUUID(), clientId, label: `Connection ${this.saved.profiles.length + 1} (not verified)` };
      this.saved.profiles.push(profile);
      await this.save();
    }
    const metadata = await this.discovery();
    const tokens = await (await this.request(metadata.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code,
        code_verifier: pending.verifier, redirect_uri: pending.redirect, resource }).toString()
    })).json();
    assert(typeof tokens.id_token === 'string', 'ChatGPT did not return a verifiable identity.', 502);
    let identity;
    try {
      this.jwks ||= createRemoteJWKSet(new URL(metadata.jwks_uri));
      identity = this.verifier ? await this.verifier(tokens.id_token, { audience: clientId, nonce: pending.nonce })
        : await verifyChatGPTIdentity(tokens.id_token, clientId, pending.nonce, this.jwks);
    } catch { throw new AppError('ChatGPT identity verification failed. Return to RestockPilot and reconnect.', 502); }
    assert(identity.nonce === pending.nonce && typeof identity.sub === 'string', 'ChatGPT identity did not match this sign-in.', 400);
    assert(!profile.subject || profile.subject === identity.sub, 'The signed-in account differs from the saved registration.', 400);
    const granted = typeof tokens.scope === 'string' ? tokens.scope.split(' ') : [];
    const sharing = granted.includes('chatgpt.tokens.use.direct') && granted.includes('resource.invoke');
    assert(!sharing || (typeof tokens.access_token === 'string' && Number(tokens.expires_in) > 0), 'ChatGPT did not return usable plan access.', 502);
    profile.subject = identity.sub;
    profile.label = `${identity.email || identity.name || 'ChatGPT account'} · ${profile.id.slice(0, 6)}`;
    await this.save();
    this.session = { profile, tokens, sharing, expires: Date.now() + Number(tokens.expires_in || 0) * 1000 };
    this.modelsCache = null;
    return this.state();
  }
  async accessToken() {
    assert(this.session?.sharing, 'Connect ChatGPT and allow RestockPilot to use your plan first.', 503);
    if (this.session.expires > Date.now() + 60000) return this.session.tokens.access_token;
    if (!this.refreshing) this.refreshing = this.renew().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async renew() {
    const current = this.session;
    assert(current?.tokens.refresh_token, 'Your ChatGPT session expired. Reconnect your account.', 401);
    const metadata = await this.discovery();
    const tokens = await (await this.request(metadata.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: current.profile.clientId,
        refresh_token: current.tokens.refresh_token, resource }).toString()
    })).json();
    assert(this.session === current, 'The ChatGPT account changed. Try again.', 409);
    const granted = (tokens.scope || current.tokens.scope || '').split(' ');
    assert(tokens.access_token && tokens.refresh_token && Number(tokens.expires_in) > 0 && granted.includes('chatgpt.tokens.use.direct') && granted.includes('resource.invoke'), 'ChatGPT plan access could not be renewed. Reconnect your account.', 401);
    current.tokens = { ...current.tokens, ...tokens };
    current.expires = Date.now() + Number(tokens.expires_in) * 1000;
    return tokens.access_token;
  }
  async models() {
    if (this.modelsCache) return this.modelsCache;
    const current = this.session;
    const token = await this.accessToken();
    const result = await (await this.request(`${resource}/models`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert(this.session === current, 'The ChatGPT account changed. Load models again.', 409);
    assert(Array.isArray(result.models), 'ChatGPT did not return a model catalog.', 502);
    this.modelsCache = result.models.filter(row => row.visibility === 'list' && typeof row.slug === 'string').map(row => ({ slug: row.slug, name: row.display_name || row.slug }));
    return this.modelsCache;
  }
  async signOut() {
    this.pending = null;
    if (this.refreshing) await this.refreshing.catch(() => {});
    const current = this.session;
    this.session = null;
    this.modelsCache = null;
    if (!current?.tokens.refresh_token) return { revoked: !current };
    try {
      const metadata = await this.discovery();
      await this.request(metadata.revocation_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: current.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: current.profile.clientId }).toString()
      });
      return { revoked: true };
    } catch { return { revoked: false }; }
  }
}
