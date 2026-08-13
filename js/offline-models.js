// Main-thread interface to the offline on-device translator in
// translate-worker.js. Tracks which language pairs the user has explicitly
// chosen to download (opt-in — we never silently trigger a multi-megabyte
// download just because a pair was selected in the dropdowns).

const DOWNLOADED_KEY = 'lt_offline_pairs';

function pairKey(src, tgt) {
  return `${src}:${tgt}`;
}

function readDownloaded() {
  try {
    const raw = JSON.parse(localStorage.getItem(DOWNLOADED_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function writeDownloaded(pairs) {
  localStorage.setItem(DOWNLOADED_KEY, JSON.stringify(pairs));
}

export function isPairDownloaded(src, tgt) {
  return readDownloaded().includes(pairKey(src, tgt));
}

function markDownloaded(src, tgt) {
  const pairs = new Set(readDownloaded());
  pairs.add(pairKey(src, tgt));
  writeDownloaded([...pairs]);
}

// Best-effort: this only forgets our own "user opted in" record. The
// underlying model files may remain in the browser's Cache Storage until
// it's cleared or the browser evicts them under storage pressure — freeing
// that is the browser's job, not something worth reimplementing here.
export function forgetPair(src, tgt) {
  writeDownloaded(readDownloaded().filter((p) => p !== pairKey(src, tgt)));
}

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;

  worker = new Worker('./js/translate-worker.js', { type: 'module' });

  worker.onmessage = (event) => {
    const { id, type } = event.data;
    const entry = pending.get(id);
    if (!entry) return;

    if (type === 'progress') {
      if (entry.onProgress) entry.onProgress(event.data);
    } else if (type === 'ready' || type === 'result') {
      pending.delete(id);
      entry.resolve(event.data);
    } else if (type === 'error') {
      pending.delete(id);
      entry.reject(new Error(event.data.message));
    }
  };

  worker.onerror = (event) => {
    const err = new Error(event.message || 'Offline translation worker crashed');
    pending.forEach((entry) => entry.reject(err));
    pending.clear();
  };

  return worker;
}

function call(type, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, type, ...payload });
  });
}

export async function downloadPair(src, tgt, onProgress) {
  await call('warmup', { src, tgt }, onProgress);
  markDownloaded(src, tgt);
}

export async function translateOffline(src, tgt, text) {
  const { text: translatedText } = await call('translate', { src, tgt, text });
  return translatedText;
}
