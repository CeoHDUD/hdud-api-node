import { useEffect, useState } from 'react';
import { api } from './api';

function Login({ onLogged }) {
  const [email, setEmail] = useState('alex@hdud.id');
  const [password, setPassword] = useState('SenhaForte@2025');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function handleLogin(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const data = await api.login(email, password);
      api.setTokens({ access_token: data.access_token, refresh_token: data.refresh_token });
      onLogged(data.user);
    } catch (e2) {
      setErr(e2.message || 'Falha no login');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '48px auto', fontFamily: 'Arial' }}>
      <h2>HDUD — Login</h2>
      <form onSubmit={handleLogin}>
        <label>Email</label>
        <input value={email} onChange={e => setEmail(e.target.value)}
          style={{ width: '100%', padding: 10, margin: '6px 0 12px' }} />
        <label>Senha</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          style={{ width: '100%', padding: 10, margin: '6px 0 12px' }} />
        <button disabled={loading} style={{ padding: 10, width: '100%' }}>
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
      {err ? <p style={{ color: 'crimson' }}>{err}</p> : null}
      <p style={{ opacity: 0.7, marginTop: 12 }}>
        MVP UI v0.1 — React + Vite
      </p>
    </div>
  );
}

function Memories({ user, onLogout }) {
  const [memories, setMemories] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);

  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const authorId = Number(user?.author_id);

  async function loadList() {
    setErr(''); setMsg('');
    try {
      const list = await api.listMemoriesByAuthor(authorId);
      setMemories(list);
    } catch (e) {
      setErr(e.message);
    }
  }

  async function loadOne(memoryId) {
    setErr(''); setMsg('');
    try {
      const m = await api.getMemory(memoryId);
      setSelected(m);
    } catch (e) {
      setErr(e.message);
    }
  }

  async function handleCreate() {
    setErr(''); setMsg('');
    try {
      const created = await api.createMemory(authorId, newTitle, newContent);
      setMsg(`Memória criada (#${created.memory_id})`);
      setNewTitle(''); setNewContent('');
      await loadList();
    } catch (e) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) loadOne(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, padding: 16, fontFamily: 'Arial' }}>
      <div style={{ border: '1px solid #ddd', padding: 12, borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Minhas Memórias</h3>
          <button onClick={onLogout}>Sair</button>
        </div>

        <p style={{ marginTop: 0, opacity: 0.75 }}>
          user_id: {user.user_id} • author_id: {String(user.author_id)}
        </p>

        <button onClick={loadList} style={{ marginBottom: 12 }}>Recarregar</button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {memories.map(m => (
            <button
              key={m.memory_id}
              onClick={() => setSelectedId(m.memory_id)}
              style={{
                textAlign: 'left',
                padding: 10,
                borderRadius: 8,
                border: '1px solid #eee',
                background: selectedId === m.memory_id ? '#f3f3f3' : 'white'
              }}
            >
              <div style={{ fontWeight: 700 }}>{m.title}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>#{m.memory_id} • v{m.version_number}</div>
            </button>
          ))}
          {memories.length === 0 ? <div style={{ opacity: 0.7 }}>Nenhuma memória ainda.</div> : null}
        </div>
      </div>

      <div style={{ border: '1px solid #ddd', padding: 12, borderRadius: 8 }}>
        <h3>Detalhe</h3>

        {err ? <p style={{ color: 'crimson' }}>{err}</p> : null}
        {msg ? <p style={{ color: 'green' }}>{msg}</p> : null}

        {selected ? (
          <div>
            <div style={{ opacity: 0.8, marginBottom: 10 }}>
              memory_id: {selected.memory_id} • author_id: {selected.author_id} • versão: {selected.version_number}
            </div>
            <h2 style={{ marginTop: 0 }}>{selected.title}</h2>
            <pre style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
              {selected.content}
            </pre>
          </div>
        ) : (
          <p style={{ opacity: 0.7 }}>Selecione uma memória na lista.</p>
        )}

        <hr style={{ margin: '18px 0' }} />

        <h3>Criar nova</h3>
        <input
          placeholder="Título"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          style={{ width: '100%', padding: 10, marginBottom: 10 }}
        />
        <textarea
          placeholder="Conteúdo"
          value={newContent}
          onChange={e => setNewContent(e.target.value)}
          rows={6}
          style={{ width: '100%', padding: 10, marginBottom: 10 }}
        />
        <button onClick={handleCreate} disabled={!newTitle || !newContent}>
          Criar
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);

  async function boot() {
    // Se já tem token, tenta /auth/me
    try {
      const tokens = api.getTokens();
      if (tokens.access_token) {
        const me = await api.me();
        setUser(me.user ?? me);
      }
    } catch {
      // ignora
    }
  }

  useEffect(() => {
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function logout() {
    api.clearTokens();
    setUser(null);
  }

  return user
    ? <Memories user={user} onLogout={logout} />
    : <Login onLogged={setUser} />;
}
