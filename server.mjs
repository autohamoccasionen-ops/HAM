import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { QuoteError, validateRequest, calculateQuote } from './quote.mjs';

const publicMessages = {
  SERVICE_NOT_CONFIGURED: 'Die Preisabfrage ist noch nicht eingerichtet. Bitte fragen Sie den Preis bei der Garage an.',
  AUTOMATION_NOT_ENABLED: 'Die Preisabfrage wird noch geprüft. Bitte fragen Sie den Preis bei der Garage an.',
  SOURCE_UNAVAILABLE: 'Die Fahrzeugdaten konnten derzeit nicht vollständig geprüft werden. Bitte fragen Sie den Preis bei der Garage an.',
  AUTHENTICATION_REQUIRED: 'Der Datenzugang muss durch die Garage erneuert werden.',
  CONSENT_UNAVAILABLE: 'Die Verbindung zum Datenanbieter ist derzeit nicht vollständig verfügbar. Bitte fragen Sie den Preis bei der Garage an.',
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
  let lastSuccessfulQuoteAt = null;
  const jobs = new Map();
  const pruneJobs = () => { for (const [id, job] of jobs) if (Date.now() - job.createdAt > 600000) jobs.delete(id); };
  const credentialsConfigured = () => !!(env.DSTORE_USERNAME && env.DSTORE_PASSWORD && env.QUOTE_SERVICE_TOKEN?.length >= 32);
  const failure = (error, requestId) => {
    const known = error instanceof QuoteError;
    const code = known ? error.code : 'SOURCE_UNAVAILABLE';
    lastError = code;
    audit({ requestId, outcome: code });
    return { status: known ? error.status : 503, body: { status: 'manual-review', code,
      message: publicMessages[code] || (known ? error.message : publicMessages.SOURCE_UNAVAILABLE), requestId } };
  };
  async function execute(input, requestId) {
    const start = Date.now();
    try {
      const readQuote = provider || (await import('./browser-provider.mjs')).readQuote;
      const result = await readQuote(input, { username: env.DSTORE_USERNAME, password: env.DSTORE_PASSWORD });
      const quote = calculateQuote(input, result);
      lastError = null;
      lastSuccessfulQuoteAt = new Date().toISOString();
      audit({ requestId, outcome: 'quoted', elapsedMs: Date.now() - start });
      return { status: 200, body: { ...quote, requestId } };
    } catch (error) { return failure(error, requestId); }
    finally { active = false; }
  }
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
        busy: active, lastError, liveConnectionVerified: !!lastSuccessfulQuoteAt, lastSuccessfulQuoteAt,
        supportedServices: ['oel-service'] });
    }
    if (req.method === 'GET' && /^\/api\/quote-jobs\/[a-f0-9-]{36}$/.test(path)) {
      pruneJobs();
      const jobId = path.split('/').pop();
      const job = jobs.get(jobId);
      if (!job) return send(res, 404, { status: 'manual-review', code: 'JOB_NOT_FOUND' });
      if (!job.result) return send(res, 202, { status: 'pending', jobId });
      return send(res, job.result.status, job.result.body);
    }
    if (req.method !== 'POST' || !['/api/quotes', '/api/quote-jobs'].includes(path)) return send(res, 404, { error: 'NOT_FOUND' });
    const requestId = randomUUID();
    try {
      const input = validateRequest(await readBody(req));
      if (!credentialsConfigured()) throw new QuoteError('SERVICE_NOT_CONFIGURED', '', 503);
      if (env.QUOTE_AUTOMATION_ENABLED !== 'true') throw new QuoteError('AUTOMATION_NOT_ENABLED', '', 503);
      if (active) throw new QuoteError('BUSY', '', 429);
      pruneJobs();
      if (path === '/api/quote-jobs' && jobs.size >= 20) throw new QuoteError('BUSY', '', 429);
      active = true;
      if (path === '/api/quote-jobs') {
        const job = { createdAt: Date.now(), result: null };
        jobs.set(requestId, job);
        void execute(input, requestId).then(result => { job.result = result; });
        return send(res, 202, { status: 'pending', jobId: requestId });
      }
      const result = await execute(input, requestId);
      return send(res, result.status, result.body);
    } catch (error) {
      const result = failure(error, requestId);
      return send(res, result.status, result.body);
    }
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
