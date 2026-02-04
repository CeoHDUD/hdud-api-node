// C:\HDUD_DATA\hdud-api-node\src\api.js

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:4000';

function getTokens() {
  return {
    access_token: localStorage.getItem('access_token'),
    refresh_token: localStorage.getItem('refresh_token'),
  };
}

function setTokens({ access_token, refresh_token }) {
  if (access_token) localStorage.setItem('access_token', access_token);
  if (refresh_token) localStorage.setItem('refresh_token', refresh_token);
}

function clearTokens() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
}

async function apiFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const { access_token } = getTokens();

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(access_token ? { Authorization: `Bearer ${access_token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Se token expirou, tenta refresh 1x
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const { access_token: newAccess } = getTokens();
      const retry = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(newAccess ? { Authorization: `Bearer ${newAccess}` } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return parseResponse(retry);
    }
  }

  return parseResponse(res);
}

async function parseResponse(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function tryRefresh() {
  const { refresh_token } = getTokens();
  if (!refresh_token) return false;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token }),
    });

    const data = await res.json();
    if (res.ok && data?.access_token) {
      setTokens({ access_token: data.access_token, refresh_token });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const api = {
  setTokens,
  clearTokens,
  getTokens,

  login: (email, password) =>
    apiFetch('/auth/login', { method: 'POST', body: { email, password } }),

  me: () => apiFetch('/auth/me'),

  listMemoriesByAuthor: (authorId) =>
    apiFetch(`/authors/${authorId}/memories`),

  createMemory: (authorId, title, content) =>
    apiFetch(`/authors/${authorId}/memories`, { method: 'POST', body: { title, content } }),

  getMemory: (memoryId) =>
    apiFetch(`/memories/${memoryId}`),

  updateMemory: (memoryId, patch) =>
    apiFetch(`/memories/${memoryId}`, { method: 'PUT', body: patch }),

  timeline: (memoryId) =>
    apiFetch(`/memories/${memoryId}/timeline`),

  rollback: (memoryId, version) =>
    apiFetch(`/memories/${memoryId}/rollback/${version}`, { method: 'POST' }),
};
