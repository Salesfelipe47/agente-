const axios = require('axios');

const BASE_URL = process.env.EVOLUTION_API_URL;
const API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE;

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    apikey: API_KEY,
    'Content-Type': 'application/json',
  },
});

async function sendText(to, text) {
  try {
    await api.post(`/message/sendText/${INSTANCE}`, {
      number: to,
      text,
    });
  } catch (err) {
    console.error('[Evolution] Erro ao enviar mensagem:', err.response?.data || err.message);
  }
}

async function sendTyping(to, durationMs = 1500) {
  try {
    await api.post(`/chat/sendPresence/${INSTANCE}`, {
      number: to,
      options: { presence: 'composing', delay: durationMs },
    });
  } catch {
    // ignora erro de presença
  }
}

async function transferToAttendant(to) {
  const attendantNumber = process.env.ATENDENTE_NUMERO;
  const message = `📲 *Transferindo para atendente...*\n\nUm especialista em CNH Facilitada vai te atender agora!\n⏳ _Aguarde um momento._`;
  await sendText(to, message);

  // Notifica o atendente (opcional)
  if (attendantNumber) {
    await sendText(
      attendantNumber,
      `🔔 *Novo lead!*\nCliente ${to} quer fechar CNH.\nAtenda agora! 🚗`
    );
  }
}

module.exports = { sendText, sendTyping, transferToAttendant };
