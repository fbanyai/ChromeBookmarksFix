import { sleep } from './util.js';

const STATUS_TEXT = {
  400: 'Bad request',
  401: 'Login required',
  402: 'Payment required',
  403: 'Forbidden – the site may block automated checks',
  404: 'Not found',
  405: 'Method not allowed',
  406: 'Not acceptable',
  408: 'Request timeout',
  410: 'Gone',
  429: 'Too many requests – rate limited',
  451: 'Unavailable for legal reasons',
  500: 'Internal server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
  521: 'Web server is down',
  522: 'Connection timed out',
  523: 'Origin is unreachable',
  525: 'SSL handshake failed',
  526: 'Invalid SSL certificate',
  999: 'Request denied – the site blocks automated checks',
};

const UNCERTAIN_CODES = new Set([401, 403, 429, 999]);

// [pattern, status, readable cause]
const NET_ERRORS = [
  [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/, 'failed', 'Domain does not exist (DNS lookup failed)'],
  [/ERR_CONNECTION_REFUSED/, 'failed', 'Connection refused'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, 'failed', 'Connection timed out'],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_FAILED/, 'failed', 'Connection dropped by the server'],
  [/ERR_ADDRESS_UNREACHABLE|ERR_ADDRESS_INVALID/, 'failed', 'Server unreachable'],
  [/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/, 'failed', 'SSL / certificate error'],
  [/ERR_TOO_MANY_REDIRECTS/, 'failed', 'Too many redirects'],
  [/ERR_INVALID_URL|ERR_UNSAFE_PORT|ERR_INVALID_RESPONSE/, 'failed', 'Invalid URL or response'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_PROXY_/, 'uncertain', 'Your own connection had a problem'],
  [/ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/, 'uncertain', 'Blocked by another extension or policy'],
];

function normalize(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

// fetch() only reports "Failed to fetch"; webRequest knows the real network error (net::ERR_*).
export class NetTracker {
  constructor(origin) {
    this.errors = new Map();
    this.redirects = new Map();
    this.onError = (d) => {
      if (d.initiator === origin && d.error !== 'net::ERR_ABORTED') this.errors.set(d.url, d.error);
    };
    this.onRedirect = (d) => {
      if (d.initiator === origin) this.redirects.set(d.url, d.redirectUrl);
    };
  }

  start() {
    chrome.webRequest.onErrorOccurred.addListener(this.onError, { urls: ['<all_urls>'] });
    chrome.webRequest.onBeforeRedirect.addListener(this.onRedirect, { urls: ['<all_urls>'] });
  }

  stop() {
    chrome.webRequest.onErrorOccurred.removeListener(this.onError);
    chrome.webRequest.onBeforeRedirect.removeListener(this.onRedirect);
  }

  // Follows the redirect chain from `url` and returns (and clears) the first recorded error.
  take(url) {
    let found = null;
    let u = normalize(url);
    for (let hop = 0; u && hop < 25; hop++) {
      found ??= this.errors.get(u) ?? null;
      this.errors.delete(u);
      const next = this.redirects.get(u);
      this.redirects.delete(u);
      u = next;
    }
    return found;
  }
}

export function skipReason(url) {
  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return 'Invalid URL';
  }
  return protocol === 'http:' || protocol === 'https:' ? null : `Not a web link (${protocol})`;
}

async function attempt(url, method, { timeoutMs, signal, tracker }) {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCancel = () => controller.abort();
  signal.addEventListener('abort', onCancel, { once: true });
  tracker.take(url);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (method === 'GET') res.body?.cancel().catch(() => {});
    return {
      status: res.status,
      finalUrl: res.url,
      redirected: res.redirected,
      cfChallenge: res.headers.get('cf-mitigated') === 'challenge',
    };
  } catch (err) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (timedOut) return { error: true, timeout: true };
    await sleep(50); // let webRequest.onErrorOccurred land
    return { error: true, netError: tracker.take(url), message: err.message };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCancel);
  }
}

function classify(r, timeoutMs) {
  if (r.error) {
    if (r.timeout) return { status: 'failed', cause: `No response within ${timeoutMs / 1000}s` };
    if (r.netError) {
      const match = NET_ERRORS.find(([re]) => re.test(r.netError));
      const code = r.netError.replace('net::', '');
      return { status: match?.[1] ?? 'failed', cause: `${match?.[2] ?? 'Network error'} (${code})` };
    }
    return { status: 'failed', cause: `Network error${r.message ? `: ${r.message}` : ''}` };
  }

  const code = r.status;
  const finalUrl = r.redirected ? r.finalUrl : undefined;
  if (r.cfChallenge) return { status: 'uncertain', code, finalUrl, cause: `HTTP ${code} – Cloudflare bot challenge` };
  if (code < 400) return { status: 'ok', code, finalUrl, cause: r.redirected ? `HTTP ${code} after redirect` : `HTTP ${code}` };

  const cause = `HTTP ${code}${STATUS_TEXT[code] ? ` – ${STATUS_TEXT[code]}` : ''}`;
  return { status: UNCERTAIN_CODES.has(code) ? 'uncertain' : 'failed', code, finalUrl, cause };
}

export async function checkUrl(url, opts) {
  const started = performance.now();
  let r = await attempt(url, 'HEAD', opts);
  // Many servers mishandle HEAD, so confirm any failure with a GET (unless HEAD simply timed out).
  if (!r.timeout && (r.error || r.status >= 400)) {
    const g = await attempt(url, 'GET', opts);
    if (!g.error || r.error) r = g;
  }
  return { ...classify(r, opts.timeoutMs), ms: Math.round(performance.now() - started) };
}

export async function checkAll(urls, { concurrency, onResult, ...opts }) {
  let next = 0;
  async function worker() {
    while (next < urls.length && !opts.signal.aborted) {
      const url = urls[next++];
      let result;
      try {
        result = await checkUrl(url, opts);
      } catch (err) {
        if (opts.signal.aborted) return;
        result = { status: 'failed', cause: `Unexpected error: ${err.message}` };
      }
      onResult(url, result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
}
