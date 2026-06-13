require('dotenv').config();
const express = require('express');
const { getAIResponse } = require('./groq');
const { sendText, sendTyping, transferToAttendant } = require('./evolution');
const sessions = require('./sessions');

const app = express();
app.use(express.json());

// Fila simples para evitar respostas duplicadas
const processing = new Set();

app.get('/', (req, res) => {
  const stats = sessions.getStats();
  res.json({ status: 'online', sessions: stats });
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido pro Evolution não retentar

  try {
    const body = req.body;

    // Filtra apenas mensagens recebidas (não enviadas pelo bot)
    const event = body.event;
    if (event !== 'messages.upsert') return;

    const message = body.data;
    if (!message) return;

    // Ignora mensagens do próprio bot / grupos
    if (message.key?.fromMe) return;
    if (message.key?.remoteJid?.endsWith('@g.us')) return; // grupo

    const phone = message.key.remoteJid.replace('@s.whatsapp.net', '');
    const text =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.buttonsResponseMessage?.selectedDisplayText ||
      message.message?.listResponseMessage?.title ||
      '';

    if (!text.trim()) return;

    // Evita processar o mesmo usuário em paralelo
    if (processing.has(phone)) return;
    processing.add(phone);

    try {
      await handleMessage(phone, text.trim());
    } finally {
      processing.delete(phone);
    }
  } catch (err) {
    console.error('[Webhook] Erro:', err.message);
  }
});

async function handleMessage(phone, text) {
  // Se já foi transferido para humano, ignora
  if (sessions.isTransferred(phone)) return;

  console.log(`[${phone}] →`, text);

  // Adiciona mensagem do usuário ao histórico
  sessions.addMessage(phone, 'user', text);

  // Simula digitação
  await sendTyping(phone, 1200);

  // Pega resposta da IA
  const session = sessions.getOrCreateSession(phone);
  const response = await getAIResponse(session.history);

  if (!response) {
    await sendText(phone, 'Desculpe, tive um problema. Pode repetir? 😊');
    return;
  }

  // Verifica se a IA decidiu transferir
  const shouldTransfer = response.includes('[TRANSFERIR_ATENDENTE]');
  const cleanResponse = response.replace('[TRANSFERIR_ATENDENTE]', '').trim();

  // Adiciona resposta da IA ao histórico
  sessions.addMessage(phone, 'assistant', cleanResponse);

  // Envia resposta
  if (cleanResponse) {
    await sendText(phone, cleanResponse);
  }

  // Transfere se necessário
  if (shouldTransfer) {
    sessions.markTransferred(phone);
    await transferToAttendant(phone);
  }

  console.log(`[${phone}] ←`, cleanResponse.substring(0, 80));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚗 Agente CNH rodando na porta ${PORT}`);
  console.log(`📡 Webhook: POST /webhook`);
});
