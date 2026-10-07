import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGPTConnection, verifyChatGPTIdentity } from '../lib/chatgpt.mjs';
import { generateKeyPair, SignJWT } from 'jose';



const metadata = { issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' };
test('Signed ChatGPT identities require the trusted key, issuer, audience, nonce, and unexpired token', async () => {
  const keys = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const sign = (overrides = {}, key = keys.privateKey) => new SignJWT({ iss: metadata.issuer, aud: 'oaiapp_test', sub: 'test-user',
    exp: Math.floor(Date.now() / 1000) + 300, nonce: 'expected-nonce', ...overrides }).setProtectedHeader({ alg: 'RS256' }).sign(key);
  assert.equal((await verifyChatGPTIdentity(await sign(), 'oaiapp_test', 'expected-nonce', keys.publicKey)).sub, 'test-user');
  for (const claims of [{ iss: 'https://wrong.example' }, { aud: 'wrong-client' }, { nonce: 'wrong-nonce' }, { exp: 1 }]) {
    await assert.rejects(verifyChatGPTIdentity(await sign(claims), 'oaiapp_test', 'expected-nonce', keys.publicKey));
  }
  await assert.rejects(verifyChatGPTIdentity(await sign({}, other.privateKey), 'oaiapp_test', 'expected-nonce', keys.publicKey));
});
async function connection(t, { granted = true, verifyError = false, subject = 'account-a' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'restockpilot-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('openid-configuration')) return Response.json(metadata);
    if (url.endsWith('/token')) return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh',
      id_token: 'private-id', expires_in: 3600, scope: granted ? 'openid profile email resource.invoke chatgpt.tokens.use.direct' : 'openid profile email' });
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'test-model', display_name: 'Test model', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] });
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
    throw new Error('Unexpected URL');
  };
  const auth = await new ChatGPTConnection(dir, { fetcher, verifier: async (token, expected) => {
    if (verifyError) throw new Error('bad signature');
    return { sub: subject, nonce: expected.nonce, email: 'user@example.test' };
  } }).init();
  const finish = async (start, clientId = 'oaiapp_test') => auth.callback(new URLSearchParams({ state: new URL(start.url).searchParams.get('state'), code: 'one-time-code', client_id: clientId }), start.cookie);
  return { auth, calls, dir, finish };
}
test('ChatGPT sign-in binds state, PKCE, browser cookie, and consumes the callback once', async t => {
  const { auth, calls, finish, dir } = await connection(t);
  const start = await auth.begin(4317);
  const url = new URL(start.url);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'RestockPilot');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4317/auth/callback');
  const params = new URLSearchParams({ state: url.searchParams.get('state'), code: 'code', client_id: 'oaiapp_test' });
  await assert.rejects(auth.callback(params, 'wrong-browser'), /did not match/);
  await finish(start);
  assert.equal(auth.state().sharing, true);
  await assert.rejects(finish(start), /did not match/);
  const stored = await readFile(join(dir, 'chatgpt-registrations.json'), 'utf8');
  for (const secret of ['private-access', 'private-refresh', 'private-id']) {
    assert.ok(!stored.includes(secret)); assert.ok(!JSON.stringify(auth.state()).includes(secret));
  }
  assert.ok(calls.find(call => call.url.endsWith('/token')).options.body.includes('client_id=oaiapp_test'));
  const restart = await new ChatGPTConnection(dir, { fetcher: auth.fetcher }).init();
  assert.equal(restart.state().connected, false);
  const reconnect = new URL((await restart.begin(4320, auth.state().profileId)).url);
  assert.equal(reconnect.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(reconnect.searchParams.get('ext_agent_host_id'), url.searchParams.get('ext_agent_host_id'));
});
test('Declined consent and unverified identities cannot enable plan access', async t => {
  const { auth } = await connection(t);
  const start = await auth.begin(4317);
  await assert.rejects(auth.callback(new URLSearchParams({ state: new URL(start.url).searchParams.get('state'), error: 'access_denied' }), start.cookie), /not authorized/);
  assert.equal(auth.state().connected, false);
  const invalid = await connection(t, { verifyError: true });
  await assert.rejects(invalid.finish(await invalid.auth.begin(4317)), /verification failed/);
  assert.equal(invalid.auth.state().connected, false);
  const identityOnly = await connection(t, { granted: false });
  await identityOnly.finish(await identityOnly.auth.begin(4317));
  assert.equal(identityOnly.auth.state().connected, true);
  assert.equal(identityOnly.auth.state().sharing, false);
  await assert.rejects(identityOnly.auth.accessToken(), /allow RestockPilot/);
});
test('ChatGPT catalog filters hidden models, concurrent refresh is serialized, sign-out clears credentials', async t => {
  const { auth, finish, calls } = await connection(t);
  await finish(await auth.begin(4317));
  assert.deepEqual(await auth.models(), [{ slug: 'test-model', name: 'Test model' }]);
  auth.session.expires = 0;
  await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.equal(calls.filter(call => call.url.endsWith('/token')).length, 2);
  assert.deepEqual(await auth.signOut(), { revoked: true });
  assert.equal(auth.state().connected, false);
  assert.equal(auth.session, null);
});
test('Reauthorization rejects a changed client registration and keeps the current session', async t => {
  const { auth, finish } = await connection(t);
  await finish(await auth.begin(4317));
  const original = auth.session;
  const start = await auth.begin(4317, auth.state().profileId);
  await assert.rejects(finish(start, 'oaiapp_wrong'), /does not match/);
  assert.equal(auth.session, original);
});
function streamResponse(events, chunkSize = 7) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
