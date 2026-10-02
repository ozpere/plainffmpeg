/**
 * Optional external translation engine (BYOK, OpenAI-compatible only).
 *
 * The local GGUF engine stays the default. When the user opts into External,
 * this module sends the SAME system prompt + user prompt the local path uses
 * to any OpenAI-shaped `/chat/completions` endpoint (Groq, OpenRouter, ...),
 * then the caller runs the result through the identical fixup pipeline.
 *
 * Secrets: the API key lives encrypted via Electron safeStorage and is only
 * ever attached to the outbound request. It never appears in errors, logs,
 * status payloads, or the renderer. Require-safe in plain Node (smoke tests):
 * config helpers degrade gracefully outside Electron.
 */

const EXTERNAL_TIMEOUT_MS = 30000;

// Presets fill baseUrl + a starting model; the user edits and saves their own
// values with their own key. Models churn, so these are starting points only.
const EXTERNAL_PRESETS = [
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
  { id: 'custom', label: 'Custom...', baseUrl: '', model: '' },
];

function normalizeBaseUrl(v) {
  let s = String(v || '').trim();
  // Accept a pasted full endpoint; we always append the path ourselves.
  s = s.replace(/\/+$/, '').replace(/\/chat\/completions\/?$/i, '');
  return s;
}

function encryptionAvailable(ss) {
  // Linux without a keyring exposes the API but cannot encrypt - check first.
  if (!ss || typeof ss.encryptString !== 'function' || typeof ss.decryptString !== 'function') return false;
  if (typeof ss.isEncryptionAvailable === 'function' && !ss.isEncryptionAvailable()) return false;
  return true;
}

// Same message shape the local engine uses: system rules + user task.
function buildExternalMessages(systemPrompt, userPrompt) {
  return [
    { role: 'system', content: String(systemPrompt || '') },
    { role: 'user', content: String(userPrompt || '') },
  ];
}

// OpenAI-shaped response -> raw text. Supports string content and the
// content-part array some gateways return.
function parseOpenAIContent(body) {
  const msg = body && body.choices && body.choices[0] && body.choices[0].message;
  const content = msg && msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((p) => (typeof p === 'string' ? p : (p && p.text) || ''))
      .join('')
      .trim();
    if (text) return text;
  }
  throw new Error('External AI returned an unexpected response shape.');
}

// Plain-language hint per failure class. Never includes the key.
function externalErrorHint(err) {
  const m = String((err && err.message) || err || '');
  if (/API key|401|403/i.test(m)) {
    return 'Check the API key in External AI settings (wrong key, revoked, or wrong provider for this URL), then Test again.';
  }
  if (/429|rate/i.test(m)) {
    return 'The provider rate-limited this key (free tiers are strict) - wait a minute, then Test or Translate again.';
  }
  if (/timed out|timeout|abort/i.test(m)) {
    return 'The request timed out - check the connection and base URL, then try again.';
  }
  if (/not set up|not configured/i.test(m)) {
    return 'Open External AI settings and save a base URL, model, and API key first.';
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(m)) {
    return 'Could not reach the provider - check the connection and base URL.';
  }
  return '';
}

async function callExternalTranslate({ baseUrl, apiKey, model, system, user, timeoutMs, fetchImpl }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!/^https?:\/\/.+/i.test(base)) throw new Error('External AI needs a valid http(s) base URL.');
  if (!String(apiKey || '').trim()) throw new Error('External AI API key is missing.');
  if (!String(model || '').trim()) throw new Error('External AI model is missing.');
  if (!String(user || '').trim()) throw new Error('Nothing to translate.');
  const doFetch = fetchImpl || fetch;
  const ctrl = new AbortController();
  const ms = timeoutMs > 0 ? timeoutMs : EXTERNAL_TIMEOUT_MS;
  const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, ms);
  if (timer.unref) timer.unref();
  let res;
  try {
    res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(apiKey).trim()}`,
      },
      body: JSON.stringify({
        model: String(model).trim(),
        messages: buildExternalMessages(system, user),
        temperature: 0.1,
        max_tokens: 256,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)))) {
      throw new Error(`External AI request timed out after ${Math.round(ms / 1000)}s.`);
    }
    throw new Error(`External AI request failed: ${String((e && e.message) || e)}`);
  }
  clearTimeout(timer);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`External AI rejected the API key (HTTP ${res.status}).`);
  }
  if (res.status === 429) {
    throw new Error('External AI rate-limited this key (HTTP 429).');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = String(await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`External AI failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('External AI returned a non-JSON response.');
  }
  const text = parseOpenAIContent(body);
  if (!text.trim()) throw new Error('External AI returned empty output.');
  return { text, model: String(model).trim() };
}

// ---------------------------------------------------------------------------
// Config store: non-secrets in <userData>/external.json, the key encrypted via
// Electron safeStorage in <userData>/external-key.bin. Portable runs resolve
// userData exe-side, so the key travels with the folder.
// ---------------------------------------------------------------------------

function externalConfigDir() {
  if (process.env.EXTERNAL_CONFIG_DIR) return process.env.EXTERNAL_CONFIG_DIR;
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch { /* plain Node */ }
  return null;
}

function safeStorage() {
  try {
    const electron = require('electron');
    return (electron && electron.safeStorage) || null;
  } catch { return null; }
}

function readPublicConfig() {
  const empty = { configured: false, baseUrl: '', model: '', presetId: '', hasKey: false };
  const dir = externalConfigDir();
  if (!dir) return empty;
  try {
    const fs = require('fs');
    const path = require('path');
    const raw = fs.readFileSync(path.join(dir, 'external.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const baseUrl = normalizeBaseUrl(parsed.baseUrl);
    const model = String(parsed.model || '').trim();
    let hasKey = false;
    try {
      const st = fs.statSync(path.join(dir, 'external-key.bin'));
      hasKey = st.isFile() && st.size > 0;
    } catch { hasKey = false; }
    if (!baseUrl || !model || !hasKey) return { ...empty, baseUrl, model, presetId: String(parsed.presetId || ''), hasKey };
    return { configured: true, baseUrl, model, presetId: String(parsed.presetId || ''), hasKey: true };
  } catch { return empty; }
}

function readFullConfig() {
  const pub = readPublicConfig();
  if (!pub.configured) return { ...pub, apiKey: '' };
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = externalConfigDir();
    const enc = fs.readFileSync(path.join(dir, 'external-key.bin'));
    const ss = safeStorage();
    if (!encryptionAvailable(ss)) {
      throw new Error('OS key storage is unavailable in this context.');
    }
    const apiKey = ss.decryptString(enc);
    if (!apiKey) throw new Error('Stored API key could not be decrypted.');
    return { ...pub, apiKey };
  } catch (e) {
    return { ...pub, configured: false, apiKey: '', keyError: String((e && e.message) || e) };
  }
}

function saveExternalConfig({ baseUrl, model, apiKey, presetId } = {}) {
  const dir = externalConfigDir();
  if (!dir) throw new Error('Settings storage is unavailable in this context.');
  const base = normalizeBaseUrl(baseUrl);
  if (!/^https?:\/\/.+/i.test(base)) throw new Error('Settings need a valid http(s) base URL.');
  const m = String(model || '').trim();
  if (!m) throw new Error('Settings need a model name.');
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Settings need an API key.');
  const ss = safeStorage();
  if (!encryptionAvailable(ss)) {
    throw new Error('OS key storage is unavailable in this context.');
  }
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'external.json'), JSON.stringify({ baseUrl: base, model: m, presetId: String(presetId || ''), updatedAt: Date.now() }));
  fs.writeFileSync(path.join(dir, 'external-key.bin'), ss.encryptString(key));
  return readPublicConfig();
}

function clearExternalConfig() {
  const dir = externalConfigDir();
  if (!dir) return;
  try {
    const fs = require('fs');
    const path = require('path');
    fs.rmSync(path.join(dir, 'external.json'), { force: true });
    fs.rmSync(path.join(dir, 'external-key.bin'), { force: true });
  } catch { /* already gone */ }
}

module.exports = {
  EXTERNAL_TIMEOUT_MS,
  EXTERNAL_PRESETS,
  normalizeBaseUrl,
  buildExternalMessages,
  parseOpenAIContent,
  externalErrorHint,
  callExternalTranslate,
  externalConfigDir,
  readPublicConfig,
  readFullConfig,
  saveExternalConfig,
  clearExternalConfig,
};
