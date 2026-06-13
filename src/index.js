require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const express = require('express');
const { getAIResponse } = require('./groq');
const sessions = require('./sessions');

process.on('uncaughtException', (err) => console.error('[ERRO]', err.message));
process.on('unhandledRejection', (err) => console.error('[PROMISE]', err?.message || err));

const app = express();
app.get('/', (_, res) => res.json({ status: 'online', sessions: sessions.getStats() }));
app.listen(process.env.PORT || 3000);

const processing = new Set();

// Cache: mapeia @lid JID → número real (@s.whatsapp.net)
// Wave 1 (stub=CIPHERTEXT) chega com senderPn mas sem msg.message
// Wave 2 (decifrada) chega com msg.message mas sem senderPn
// Guardamos da wave 1 para usar na wave 2
const lidPhoneCache = new Map();

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Agente CNH', 'Chrome', '1.0'],
    getMessage: async () => undefined,
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
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid.endsWith('@g.us')) continue;

      const remoteJid = msg.key.remoteJid;
      const isLid = remoteJid.endsWith('@lid');

      // Wave 1: stub=CIPHERTEXT — guarda senderPn no cache para usar depois
      if (msg.messageStubType === 2 && isLid) {
        const keyJson = JSON.parse(JSON.stringify(msg.key));
        if (keyJson.senderPn) {
          lidPhoneCache.set(remoteJid, keyJson.senderPn);
          console.log(`[LID_CACHE] ${remoteJid} → ${keyJson.senderPn}`);
        }
        continue; // mensagem não decifrada ainda, aguarda wave 2
      }

      // Descarta outros stubs (grupos, revoke, etc)
      if (msg.messageStubType) continue;

      // Resolve phone: @lid usa cache ou senderPn direto
      let phone;
      if (isLid) {
        const keyJson = JSON.parse(JSON.stringify(msg.key));
        phone = keyJson.senderPn || lidPhoneCache.get(remoteJid) || remoteJid;
      } else {
        phone = remoteJid;
      }

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
