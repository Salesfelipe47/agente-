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
    getMessage: async () => undefined, // ignora retry de mensagens com Bad MAC
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
    // DIAG-1: toda entrada no evento
    console.log(`[DIAG-1] upsert | type=${type} | count=${messages.length}`);

    if (type !== 'notify') {
      console.log(`[DIAG-2] DESCARTE | type_nao_notify | type=${type}`);
      return;
    }

    for (const msg of messages) {
      // DIAG-3: campos individuais de cada mensagem
      console.log([
        `[DIAG-3] ENTRADA`,
        `remoteJid=${msg.key?.remoteJid}`,
        `fromMe=${msg.key?.fromMe}`,
        `stubType=${msg.messageStubType ?? 'nenhum'}`,
        `stubParams=${JSON.stringify(msg.messageStubParameters ?? [])}`,
        `senderPn_direto=${msg.key?.senderPn ?? 'undefined'}`,
        `participant=${msg.key?.participant ?? 'undefined'}`,
        `pushName=${msg.pushName ?? 'undefined'}`,
        `tem_message=${msg.message != null ? 'SIM' : 'NAO'}`,
      ].join(' | '));

      // DIAG-4: JSON completo (800 chars) para ver campos ocultos pelo proto
      console.log(`[DIAG-4] JSON | ${JSON.stringify(msg).substring(0, 800)}`);

      if (msg.key.fromMe) {
        console.log(`[DIAG-5] DESCARTE | fromMe=true | jid=${msg.key.remoteJid}`);
        continue;
      }

      if (msg.key.remoteJid.endsWith('@g.us')) {
        console.log(`[DIAG-6] DESCARTE | grupo | jid=${msg.key.remoteJid}`);
        continue;
      }

      // ── lógica existente sem alteração ──
      const keyData = JSON.parse(JSON.stringify(msg.key));
      const phone = keyData.remoteJid?.endsWith('@lid')
        ? (keyData.senderPn || keyData.remoteJid)
        : keyData.remoteJid;

      // DIAG-7: resultado da extração de phone
      console.log(`[DIAG-7] PHONE | keyData.senderPn=${keyData.senderPn ?? 'undefined'} | resolvido=${phone}`);

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

      // DIAG-8: qual campo originou o texto
      const textSource = !m                                            ? 'msg.message=null'
        : m.conversation                                               ? 'conversation'
        : m.extendedTextMessage?.text                                  ? 'extendedTextMessage'
        : m.imageMessage?.caption                                      ? 'imageMessage.caption'
        : m.videoMessage?.caption                                      ? 'videoMessage.caption'
        : m.buttonsResponseMessage?.selectedDisplayText                ? 'buttonsResponse'
        : m.listResponseMessage?.title                                 ? 'listResponse'
        : m.templateButtonReplyMessage?.selectedDisplayText            ? 'templateButtonReply'
        : m.ephemeralMessage                                           ? 'ephemeralMessage'
        : m.viewOnceMessage                                            ? 'viewOnceMessage'
        : `NENHUM(keys=${Object.keys(m).join(',')})`;
      console.log(`[DIAG-8] TEXTO | fonte=${textSource} | valor="${text.substring(0, 120)}"`);

      if (!text.trim()) {
        console.log(`[DIAG-9] DESCARTE | texto_vazio | stub=${msg.messageStubType ?? 'nenhum'}`);
        continue;
      }

      if (processing.has(phone)) {
        console.log(`[DIAG-10] DESCARTE | ja_processando | phone=${phone}`);
        continue;
      }

      console.log(`[DIAG-11] ENVIANDO_PARA_IA | phone=${phone} | texto="${text.substring(0, 80)}"`);
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
  if (sessions.isTransferred(phone)) {
    console.log(`[DIAG-12] DESCARTE | transferido | phone=${phone}`);
    return;
  }

  console.log(`[${phone}] → ${text}`);

  sessions.addMessage(phone, 'user', text);

  // Simula digitando
  await sock.sendPresenceUpdate('composing', phone);
  await new Promise(r => setTimeout(r, 1500));

  const session = sessions.getOrCreateSession(phone);
  const response = await getAIResponse(session.history);

  if (!response) {
    console.log(`[DIAG-13] DESCARTE | resposta_ia_vazia | phone=${phone}`);
    return;
  }

  const shouldTransfer = response.includes('[TRANSFERIR_ATENDENTE]');
  const cleanResponse = response.replace('[TRANSFERIR_ATENDENTE]', '').trim();

  sessions.addMessage(phone, 'assistant', cleanResponse);

  await sock.sendPresenceUpdate('paused', phone);

  if (cleanResponse) {
    console.log(`[DIAG-14] ENVIANDO_MSG | phone=${phone} | texto="${cleanResponse.substring(0, 80)}"`);
    await sock.sendMessage(phone, { text: cleanResponse });
    console.log(`[DIAG-15] MSG_ENVIADA | phone=${phone}`);
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
