import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

const APP_DIR = path.join(os.homedir(), ".e3d-agent-trading-floor");
const FALLBACK_FILE = path.join(APP_DIR, "e3d-auth.enc");
const KEYCHAIN_SERVICE = process.env.E3D_AUTH_KEYCHAIN_SERVICE || "e3d-agent-trading-floor";
const KEYCHAIN_ACCOUNT = process.env.E3D_AUTH_KEYCHAIN_ACCOUNT || "e3d-ai";
const E3D_LOGIN_URL = process.env.E3D_LOGIN_URL || "https://e3d.ai/login";
const E3D_AUTH_STATUS_URL = process.env.E3D_AUTH_STATUS_URL || "https://e3d.ai/auth/status";
const E3D_API_BASE_URL = process.env.E3D_API_BASE_URL || "https://e3d.ai/api";
const FALLBACK_SALT = "e3d-agent-trading-floor-fallback-v1";

function ensureAppDir() {
  fs.mkdirSync(APP_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function safeUsername() {
  try {
    return String(os.userInfo().username || "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function deriveFallbackKey() {
  const material = [os.hostname(), safeUsername(), KEYCHAIN_SERVICE, process.platform].join("|");
  return crypto.scryptSync(material, FALLBACK_SALT, 32);
}

function encryptFallback(text) {
  const key = deriveFallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(text || ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    updatedAt: nowIso(),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptFallback(payload) {
  if (!payload || typeof payload !== "object") return null;
  const iv = Buffer.from(String(payload.iv || ""), "base64");
  const tag = Buffer.from(String(payload.tag || ""), "base64");
  const ciphertext = Buffer.from(String(payload.ciphertext || ""), "base64");
  if (!iv.length || !tag.length || !ciphertext.length) return null;
  const key = deriveFallbackKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return plaintext;
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return null;
  const mode = String(record.mode || "").trim();
  if (!mode) return null;

  const normalized = {
    mode,
    email: String(record.email || record.username || "").trim(),
    username: String(record.username || record.email || "").trim(),
    apiKey: String(record.apiKey || record.api_key || "").trim(),
    cookie: String(record.cookie || record.cookieHeader || record.sessionCookie || "").trim(),
    cookieName: String(record.cookieName || "").trim(),
    source: String(record.source || "").trim() || null,
    updatedAt: String(record.updatedAt || record.updated_at || nowIso()).trim(),
    lastError: String(record.lastError || record.last_error || "").trim() || null
  };

  if (mode === "api_key" && !normalized.apiKey) return null;
  if (mode === "login" && !normalized.cookie) return null;
  return normalized;
}

function redactRecord(record) {
  const normalized = normalizeRecord(record);
  if (!normalized) return {
    ok: true,
    connected: false,
    mode: null,
    source: null,
    email: null,
    username: null,
    hasApiKey: false,
    hasSession: false,
    updatedAt: null,
    lastError: null
  };

  const apiKeyPreview = normalized.mode === "api_key" && normalized.apiKey
    ? normalized.apiKey.slice(0, 8) + "…"
    : null;

  return {
    ok: true,
    connected: true,
    mode: normalized.mode,
    source: normalized.source,
    email: normalized.email || null,
    username: normalized.username || null,
    hasApiKey: normalized.mode === "api_key",
    hasSession: normalized.mode === "login",
    apiKeyPreview,
    updatedAt: normalized.updatedAt || null,
    lastError: normalized.lastError || null
  };
}

function keychainAvailable() {
  return process.platform === "darwin";
}

function readFromKeychain() {
  if (!keychainAvailable()) return null;
  try {
    const out = execFileSync("security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w"
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function writeToKeychain(secret) {
  if (!keychainAvailable()) return false;
  execFileSync("security", [
    "add-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    String(secret || ""),
    "-U"
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  return true;
}

function deleteFromKeychain() {
  if (!keychainAvailable()) return false;
  try {
    execFileSync("security", [
      "delete-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
  }
  return true;
}

function readFallbackFile() {
  try {
    if (!fs.existsSync(FALLBACK_FILE)) return null;
    const payload = JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf8"));
    const plaintext = decryptFallback(payload);
    if (!plaintext) return null;
    return plaintext;
  } catch {
    return null;
  }
}

function writeFallbackFile(secret) {
  ensureAppDir();
  const payload = encryptFallback(secret);
  fs.writeFileSync(FALLBACK_FILE, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return true;
}

function deleteFallbackFile() {
  try {
    if (fs.existsSync(FALLBACK_FILE)) fs.unlinkSync(FALLBACK_FILE);
  } catch {
  }
}

function loadStoredAuth() {
  const keychainRaw = readFromKeychain();
  if (keychainRaw) {
    try {
      return normalizeRecord(JSON.parse(keychainRaw));
    } catch {
    }
  }

  const fallbackRaw = readFallbackFile();
  if (fallbackRaw) {
    try {
      return normalizeRecord(JSON.parse(fallbackRaw));
    } catch {
    }
  }

  return null;
}

function saveStoredAuth(record) {
  const normalized = normalizeRecord(record);
  if (!normalized) {
    throw new Error("INVALID_E3D_AUTH_RECORD");
  }

  const raw = JSON.stringify(normalized);
  try {
    if (keychainAvailable()) {
      writeToKeychain(raw);
      deleteFallbackFile();
      return { ...redactRecord(normalized), storage: "keychain" };
    }
  } catch {
    // Fall through to encrypted file fallback.
  }

  writeFallbackFile(raw);
  deleteFromKeychain();
  return { ...redactRecord(normalized), storage: "file" };
}

function clearStoredAuth() {
  deleteFromKeychain();
  deleteFallbackFile();
  return { ok: true };
}

function getAuthStatus() {
  const record = loadStoredAuth();
  if (!record) {
    return {
      ok: true,
      connected: false,
      mode: null,
      source: null,
      email: null,
      username: null,
      hasApiKey: false,
      hasSession: false,
      updatedAt: null,
      lastError: null
    };
  }

  return redactRecord(record);
}

function getAuthHeaders(urlOrString) {
  const record = loadStoredAuth();
  if (!record) return {};

  const target = typeof urlOrString === "string" ? urlOrString : String(urlOrString?.url || "");
  let hostname = "";
  try {
    hostname = new URL(target).hostname;
  } catch {
    hostname = "";
  }

  if (!hostname || !hostname.endsWith("e3d.ai")) return {};

  if (record.mode === "api_key" && record.apiKey) {
    return {
      "x-api-key": record.apiKey,
      "x-e3d-api-key": record.apiKey
    };
  }

  if (record.mode === "login" && record.cookie) {
    return {
      Cookie: record.cookie
    };
  }

  return {};
}

function buildCurlAuthArgs(url) {
  const headers = getAuthHeaders(url);
  const out = [];
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    out.push("-H", `${key}: ${value}`);
  }
  return out;
}

function extractSetCookieHeader(response) {
  if (!response || !response.headers) return "";

  try {
    if (typeof response.headers.getSetCookie === "function") {
      const list = response.headers.getSetCookie();
      if (Array.isArray(list) && list.length) {
        return list.map((entry) => String(entry || "").split(";")[0].trim()).filter(Boolean).join("; ");
      }
    }
  } catch {
  }

  try {
    const raw = response.headers.get("set-cookie");
    if (!raw) return "";
    return String(raw).split(/,\s*(?=[^;]+=[^;]+)/g).map((entry) => entry.split(";")[0].trim()).filter(Boolean).join("; ");
  } catch {
    return "";
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function probeApiKey(apiKey) {
  const headers = {
    Accept: "application/json",
    "x-api-key": apiKey,
    "x-e3d-api-key": apiKey
  };
  const response = await fetch(`${E3D_API_BASE_URL}/stories?limit=1`, { method: "GET", headers });
  if (!response.ok) {
    const payload = await readJsonResponse(response);
    const message = payload && typeof payload === "object" && payload.message ? String(payload.message) : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return true;
}

async function probeLogin(cookieHeader) {
  const response = await fetch(E3D_AUTH_STATUS_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Cookie: cookieHeader
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await readJsonResponse(response);
  const authenticated = !!(payload?.authenticated ?? payload?.isAuthenticated);
  if (!authenticated) {
    throw new Error(payload?.message || "Login session was not accepted");
  }
  return payload;
}

async function connectWithApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("API key is required");

  await probeApiKey(key);
  const record = saveStoredAuth({
    mode: "api_key",
    apiKey: key,
    updatedAt: nowIso(),
    source: keychainAvailable() ? "keychain" : "file"
  });
  return { ok: true, auth: record };
}

async function connectWithLogin({ username, password }) {
  const email = String(username || "").trim();
  const secret = String(password || "").trim();
  if (!email) throw new Error("Username/email is required");
  if (!secret) throw new Error("Password is required");

  const response = await fetch(E3D_LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ email, password: secret })
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && payload.message ? String(payload.message) : `HTTP ${response.status}`;
    throw new Error(message);
  }

  const cookie = extractSetCookieHeader(response);
  if (!cookie) {
    throw new Error("Login succeeded but no session cookie was returned");
  }

  await probeLogin(cookie);
  const record = saveStoredAuth({
    mode: "login",
    email: payload?.user?.email || email,
    username: payload?.user?.username || email,
    cookie,
    cookieName: cookie.split("=")[0] || "",
    updatedAt: nowIso(),
    source: keychainAvailable() ? "keychain" : "file"
  });
  return { ok: true, auth: record };
}

function e3dRequestHeaders(url, extraHeaders = {}) {
  const headers = new Headers(extraHeaders || {});
  const authHeaders = getAuthHeaders(url);
  for (const [key, value] of Object.entries(authHeaders)) {
    if (!value) continue;
    headers.set(key, value);
  }
  return headers;
}

async function e3dRequest(url, options = {}) {
  const headers = e3dRequestHeaders(url, options.headers || {});
  return fetch(url, { ...options, headers });
}

export {
  APP_DIR,
  FALLBACK_FILE,
  E3D_API_BASE_URL,
  E3D_AUTH_STATUS_URL,
  E3D_LOGIN_URL,
  buildCurlAuthArgs,
  clearStoredAuth,
  connectWithApiKey,
  connectWithLogin,
  e3dRequest,
  e3dRequestHeaders,
  getAuthHeaders,
  getAuthStatus,
  loadStoredAuth,
  normalizeRecord,
  readJsonResponse,
  saveStoredAuth
};
