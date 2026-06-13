// Gerenciamento de sessões em memória
// Cada contato tem seu próprio histórico de conversa

const sessions = new Map();

const MAX_HISTORY = 20; // máximo de mensagens por sessão
const SESSION_TTL = 60 * 60 * 1000; // 1 hora sem atividade limpa a sessão

function getSession(phone) {
  const session = sessions.get(phone);
  if (!session) return null;

  // Verifica se a sessão expirou
  if (Date.now() - session.lastActivity > SESSION_TTL) {
    sessions.delete(phone);
    return null;
  }

  return session;
}

function getOrCreateSession(phone) {
  let session = getSession(phone);
  if (!session) {
    session = {
      phone,
      history: [],
      lastActivity: Date.now(),
      transferido: false,
    };
    sessions.set(phone, session);
  }
  return session;
}

function addMessage(phone, role, content) {
  const session = getOrCreateSession(phone);
  session.history.push({ role, content });
  session.lastActivity = Date.now();

  // Mantém apenas as últimas MAX_HISTORY mensagens
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
}

function markTransferred(phone) {
  const session = getOrCreateSession(phone);
  session.transferido = true;
}

function isTransferred(phone) {
  const session = getSession(phone);
  return session?.transferido === true;
}

function resetSession(phone) {
  sessions.delete(phone);
}

function getStats() {
  return {
    total: sessions.size,
    transferred: [...sessions.values()].filter((s) => s.transferido).length,
  };
}

module.exports = {
  getOrCreateSession,
  addMessage,
  markTransferred,
  isTransferred,
  resetSession,
  getStats,
};
