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
const lidPhoneCache = new Map();

// Cache inverso: senderPn (@s.whatsapp.net) → @lid JID (para envio)
// sendMessage precisa do @lid, não do @s.whatsapp.net
const phoneLidCache = new Map();

// Controla quais phones já receberam saudação proativa da wave 1
const lidGreeted = new Set();

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
    console.log(`[MSG_EVENT] type=${type} count=${messages.length}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid.endsWith('@g.us')) continue;

        const remoteJid = msg.key.remoteJid;
        const isLid = remoteJid.endsWith('@lid');

        // Wave 1: stub=CIPHERTEXT — chaves Signal desatualizadas no contato
        // Estratégia: enviar saudação proativa para o senderPn.
        // Isso força nova troca de chaves Signal → próxima mensagem decifra corretamente.
        if (msg.messageStubType === 2 && isLid) {
          const keyJson = JSON.parse(JSON.stringify(msg.key));
          const senderPhone = keyJson.senderPn;
          if (senderPhone) {
            lidPhoneCache.set(remoteJid, senderPhone);
            phoneLidCache.set(senderPhone, remoteJid);
            console.log(`[LID_CACHE] ${remoteJid} → ${senderPhone}`);

            if (!lidGreeted.has(senderPhone) && !processing.has(senderPhone)) {
              lidGreeted.add(senderPhone);
              const sendJid = remoteJid; // usa @lid para envio
              console.log(`[SESSION_INIT] enviando para ${sendJid} (sessão: ${senderPhone})`);
              setTimeout(async () => {
                processing.add(senderPhone);
                try {
                  await handleMessage(sock, senderPhone, 'Oi', sendJid);
                } finally {
                  processing.delete(senderPhone);
                }
              }, 800);
            }
          }
          continue;
        }

        // Descarta outros stubs
        if (msg.messageStubType) continue;

        // Resolve phone: @lid usa cache ou senderPn direto
        let phone;
        if (isLid) {
          const keyJson = JSON.parse(JSON.stringify(msg.key));
          phone = keyJson.senderPn || lidPhoneCache.get(remoteJid) || remoteJid;
        } else {
          phone = remoteJid;
        }

        // Se wave 2 chegou após saudação proativa da wave 1, ignora para não duplicar
        if (lidGreeted.has(phone)) {
          lidGreeted.delete(phone);
          console.log(`[WAVE2_SKIP] saudação já enviada para ${phone}, ignorando wave 2`);
          continue;
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

        console.log(`[MSG_IN] phone=${phone} text="${text.substring(0, 60)}"`);
        if (!text.trim()) continue;
        if (processing.has(phone)) continue;

        processing.add(phone);
        try {
          // Se o contato tem @lid, usa ele para envio; senão usa o próprio phone
          const sendJid = phoneLidCache.get(phone) || phone;
          await handleMessage(sock, phone, text.trim(), sendJid);
        } finally {
          processing.delete(phone);
        }
      } catch (err) {
        console.error(`[MSG_ERR] ${err.message}`);
      }
    }
  });
}

// phone = chave de sessão (senderPn ou remoteJid)
// sendJid = JID real para envio (preferencialmente @lid se disponível)
async function handleMessage(sock, phone, text, sendJid = phone) {
  if (sessions.isTransferred(phone)) return;

  console.log(`[${phone}] → ${text} (send via ${sendJid})`);

  sessions.addMessage(phone, 'user', text);

  await sock.sendPresenceUpdate('composing', sendJid);
  await new Promise(r => setTimeout(r, 1500));

  const session = sessions.getOrCreateSession(phone);
  const response = await getAIResponse(session.history);

  if (!response) return;

  const shouldTransfer = response.includes('[TRANSFERIR_ATENDENTE]');
  const cleanResponse = response.replace('[TRANSFERIR_ATENDENTE]', '').trim();

  sessions.addMessage(phone, 'assistant', cleanResponse);

  await sock.sendPresenceUpdate('paused', sendJid);

  if (cleanResponse) {
    try {
      const sent = await sock.sendMessage(sendJid, { text: cleanResponse });
      console.log(`[SEND_OK] id=${sent?.key?.id} status=${sent?.status} to=${sendJid}`);
    } catch (e) {
      console.error(`[SEND_ERR] ${e.message} | jid=${sendJid}`);
      // Tenta fallback com @s.whatsapp.net se o @lid falhou
      const fallback = phoneLidCache.has(phone) ? phone : null;
      if (fallback && sendJid !== fallback) {
        try {
          const sent2 = await sock.sendMessage(fallback, { text: cleanResponse });
          console.log(`[SEND_FALLBACK_OK] id=${sent2?.key?.id} to=${fallback}`);
        } catch (e2) {
          console.error(`[SEND_FALLBACK_ERR] ${e2.message}`);
        }
      }
    }
  }

  if (shouldTransfer) {
    sessions.markTransferred(phone);
    await sock.sendMessage(sendJid, {
      text: '📲 *Transferindo para atendente...*\n\nUm especialista vai te atender agora! ⏳'
    });

    const atendente = process.env.ATENDENTE_NUMERO + '@s.whatsapp.net';
    const phoneClean = phone.replace('@s.whatsapp.net', '').replace('@lid', '');
    await sock.sendMessage(atendente, {
      text: `🔔 *Novo lead!*\nCliente +${phoneClean} quer fechar CNH.\nAtenda agora! 🚗`
    });
  }

  console.log(`[${phone}] ← ${cleanResponse.substring(0, 80)}`);
}

startBot();
