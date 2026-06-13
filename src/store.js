// Armazenamento em memória de conversas e clientes SSE para o painel
const conversations = new Map(); // phone → conversa
const sseClients = new Set();

const STAGES = ['gancho','qualificacao','espelho_dor','revelacao','beneficios','escassez','categoria','valor','atendente','fechado'];

function getOrCreate(phone, sendJid) {
  if (!conversations.has(phone)) {
    conversations.set(phone, {
      phone,
      sendJid: sendJid || phone,
      stage: 'gancho',
      messages: [],
      unread: 0,
      lastTime: Date.now(),
      lastText: '',
    });
  } else if (sendJid) {
    conversations.get(phone).sendJid = sendJid;
  }
  return conversations.get(phone);
}

function addMessage(phone, sendJid, { id, fromMe, text, time }) {
  const conv = getOrCreate(phone, sendJid);
  const msg = { id, fromMe, text, time: time || Date.now() };
  conv.messages.push(msg);
  conv.lastTime = msg.time;
  conv.lastText = text;
  if (!fromMe) conv.unread++;
  broadcast({ type: 'message', phone, msg });
  broadcast({ type: 'conv_update', conv: convSummary(conv) });
}

function markRead(phone) {
  const conv = conversations.get(phone);
  if (conv) conv.unread = 0;
}

function setStage(phone, stage) {
  const conv = getOrCreate(phone);
  conv.stage = stage;
  broadcast({ type: 'stage', phone, stage });
}

function convSummary(c) {
  return {
    phone: c.phone,
    sendJid: c.sendJid,
    stage: c.stage,
    unread: c.unread,
    lastTime: c.lastTime,
    lastText: c.lastText,
  };
}

function listConvs() {
  return [...conversations.values()]
    .sort((a, b) => b.lastTime - a.lastTime)
    .map(convSummary);
}

function getMessages(phone) {
  return conversations.get(phone)?.messages || [];
}

function getSendJid(phone) {
  return conversations.get(phone)?.sendJid || phone;
}

function broadcast(data) {
  const str = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(str); } catch {}
  }
}

function addSSE(res) { sseClients.add(res); }
function removeSSE(res) { sseClients.delete(res); }

module.exports = { getOrCreate, addMessage, markRead, setStage, listConvs, getMessages, getSendJid, broadcast, addSSE, removeSSE, STAGES };
