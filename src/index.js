require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const express = require('express');
const { getAIResponse } = require('./groq');
const sessions = require('./sessions');

process.on('uncaughtException', (err) => console.error('[ERRO NÃO TRATADO]', err));
process.on('unhandledRejection', (err) => console.error('[PROMISE REJEITADA]', err));

const app = express();
app.get('/', (_, res) => res.json({ status: 'online', sessions: sessions.getStats() }));
app.listen(process.env.PORT || 3000);

// Fila para evitar respostas duplicadas
const processing = new Set();

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Agente CNH', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 ESCANEIE O QR CODE ABAIXO COM SEU WHATSAPP:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão fechada. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 3000);
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado! Agente CNH online.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[EVENT] messages.upsert type=${type} count=${messages.length}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      console.log(`[MSG] from=${msg.key.remoteJid} fromMe=${msg.key.fromMe}`);
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid.endsWith('@g.us')) continue;

      const phone = msg.key.remoteJid;
      const m = msg.message;
      const text =
        m?.conversation ||
        m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption ||
        m?.videoMessage?.caption ||
        m?.buttonsResponseMessage?.selectedDisplayText ||
        m?.listResponseMessage?.title ||
        m?.templateButtonReplyMessage?.selectedDisplayText ||
        m?.ephemeralMessage?.message?.conversation ||
        m?.ephemeralMessage?.message?.extendedTextMessage?.text ||
        m?.viewOnceMessage?.message?.conversation ||
        m?.documentWithCaptionMessage?.message?.imageMessage?.caption ||
        '';

      console.log(`[FULL] ${JSON.stringify(msg).substring(0, 600)}`);
      if (!text.trim()) continue;
      if (processing.has(phone)) continue;

      processing.add(phone);
      try {
        await handleMessage(sock, phone, text.trim());
      } finally {
        processing.delete(phone);
      }
    }
  });
}

async function handleMessage(sock, phone, text) {
  if (sessions.isTransferred(phone)) return;

  console.log(`[${phone}] → ${text}`);

  sessions.addMessage(phone, 'user', text);

  // Simula digitando
  await sock.sendPresenceUpdate('composing', phone);
  await new Promise(r => setTimeout(r, 1500));

  const session = sessions.getOrCreateSession(phone);
  const response = await getAIResponse(session.history);

  if (!response) return;

  const shouldTransfer = response.includes('[TRANSFERIR_ATENDENTE]');
  const cleanResponse = response.replace('[TRANSFERIR_ATENDENTE]', '').trim();

  sessions.addMessage(phone, 'assistant', cleanResponse);

  await sock.sendPresenceUpdate('paused', phone);

  if (cleanResponse) {
    await sock.sendMessage(phone, { text: cleanResponse });
  }

  if (shouldTransfer) {
    sessions.markTransferred(phone);
    await sock.sendMessage(phone, {
      text: '📲 *Transferindo para atendente...*\n\nUm especialista vai te atender agora! ⏳'
    });

    const atendente = process.env.ATENDENTE_NUMERO + '@s.whatsapp.net';
    const phoneClean = phone.replace('@s.whatsapp.net', '');
    await sock.sendMessage(atendente, {
      text: `🔔 *Novo lead!*\nCliente +${phoneClean} quer fechar CNH.\nAtenda agora! 🚗`
    });
  }

  console.log(`[${phone}] ← ${cleanResponse.substring(0, 80)}`);
}

startBot();
