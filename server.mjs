import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { QuoteError, validateRequest, calculateQuote } from './quote.mjs';

const publicMessages = {
  SERVICE_NOT_CONFIGURED: 'Die Preisabfrage ist noch nicht eingerichtet. Bitte fragen Sie den Preis bei der Garage an.',
  AUTOMATION_NOT_ENABLED: 'Die Preisabfrage wird noch geprüft. Bitte fragen Sie den Preis bei der Garage an.',
  SOURCE_UNAVAILABLE: 'Die Fahrzeugdaten konnten derzeit nicht vollständig geprüft werden. Bitte fragen Sie den Preis bei der Garage an.',
  AUTHENTICATION_REQUIRED: 'Der Datenzugang muss durch die Garage erneuert werden.',
  MANUAL_REVIEW_REQUIRED: 'Ihre Auswahl wird individuell durch die Garage kalkuliert.',
  BUSY: 'Es läuft bereits eine Preisabfrage. Bitte versuchen Sie es in Kürze erneut.'
};

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}

function authenticated(req, token) {
  if (typeof token !== 'string' || token.length < 32) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token), actual = Buffer.from(header.slice(7));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new QuoteError('INVALID_REQUEST', 'JSON erwartet.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new QuoteError('INVALID_REQUEST', 'Anfrage zu gross.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new QuoteError('INVALID_REQUEST', 'Ungültiges JSON.', 400); }
}

export function createApp({ env = process.env, provider, audit = () => {} } = {}) {
  let active = false;
  let lastError = null;
  const credentialsConfigured = () => !!(env.DSTORE_USERNAME && env.DSTORE_PASSWORD && env.QUOTE_SERVICE_TOKEN?.length >= 32);
  return async function handle(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && (path === '/' || path === '/healthz')) {
      return send(res, 200, { status: 'running', component: 'ham-offerten-service',
        automaticQuotations: 'Use the authenticated status endpoint to check readiness.' });
    }
    if (!path.startsWith('/api/')) return send(res, 404, { error: 'NOT_FOUND' });
    if (!authenticated(req, env.QUOTE_SERVICE_TOKEN)) return send(res, 401, { error: 'UNAUTHORIZED' });
    if (req.method === 'GET' && path === '/api/status') {
      return send(res, 200, { status: credentialsConfigured() ? (env.QUOTE_AUTOMATION_ENABLED === 'true' ? 'enabled' : 'disabled') : 'not-configured',
        busy: active, lastError, liveConnectionVerified: false, supportedServices: ['oel-service'] });
    }
    if (req.method !== 'POST' || path !== '/api/quotes') return send(res, 404, { error: 'NOT_FOUND' });
    const requestId = randomUUID();
    let acquired = false;
    try {
      const input = validateRequest(await readBody(req));
      if (!credentialsConfigured()) throw new QuoteError('SERVICE_NOT_CONFIGURED', '', 503);
      if (env.QUOTE_AUTOMATION_ENABLED !== 'true') throw new QuoteError('AUTOMATION_NOT_ENABLED', '', 503);
      if (active) throw new QuoteError('BUSY', '', 429);
      active = true;
      acquired = true;
      const start = Date.now();
      const readQuote = provider || (await import('./browser-provider.mjs')).readQuote;
      const result = await readQuote(input, { username: env.DSTORE_USERNAME, password: env.DSTORE_PASSWORD });
      const quote = calculateQuote(input, result);
      lastError = null;
      audit({ requestId, outcome: 'quoted', elapsedMs: Date.now() - start });
      return send(res, 200, { ...quote, requestId });
    } catch (error) {
      const known = error instanceof QuoteError;
      const code = known ? error.code : 'SOURCE_UNAVAILABLE';
      lastError = code;
      audit({ requestId, outcome: code });
      return send(res, known ? error.status : 503, { status: 'manual-review', code,
        message: publicMessages[code] || (known ? error.message : publicMessages.SOURCE_UNAVAILABLE), requestId });
    } finally { if (acquired) active = false; }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = http.createServer(createApp({ audit: event => console.info(JSON.stringify(event)) }));
  server.requestTimeout = 150000;
  server.headersTimeout = 15000;
  server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.info('Quote service listening'));
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 25000).unref();
  });
}
