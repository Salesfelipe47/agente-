require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const express = require('express');
const path = require('path');
const store = require('./store');

process.on('uncaughtException', (err) => console.error('[ERRO]', err.message));
process.on('unhandledRejection', (err) => console.error('[PROMISE]', err?.message || err));

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Painel de atendimento
app.get('/panel', (_, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/', (_, res) => res.redirect('/panel'));

// SSE — atualizações em tempo real para o painel
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  store.addSSE(res);
  req.on('close', () => store.removeSSE(res));
});

// Lista de conversas
app.get('/api/conversations', (_, res) => res.json(store.listConvs()));

// Mensagens de uma conversa específica
app.get('/api/conversations/:phone', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const conv = store.listConvs().find(c => c.phone === phone) || {};
  res.json({ ...conv, messages: store.getMessages(phone) });
});

// Marcar como lida
app.post('/api/conversations/:phone/read', (req, res) => {
  store.markRead(decodeURIComponent(req.params.phone));
  res.json({ ok: true });
});

// Atualizar etapa do funil
app.put('/api/conversations/:phone/stage', (req, res) => {
  store.setStage(decodeURIComponent(req.params.phone), req.body.stage);
  res.json({ ok: true });
});

// Enviar mensagem via painel
app.post('/api/send', async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.json({ ok: false, error: 'Parâmetros inválidos' });

  const sendJid = store.getSendJid(to);
  console.log(`[PAINEL_SEND] to=${sendJid} text="${text.substring(0, 60)}"`);

  try {
    // Tenta enviar pelo JID preferido (pode ser @lid ou @s.whatsapp.net)
    const sent = await globalSock?.sendMessage(sendJid, { text });
    const msgId = sent?.key?.id || `local_${Date.now()}`;
    console.log(`[PAINEL_OK] id=${msgId} jid=${sendJid}`);

    // Salva a mensagem enviada na conversa
    store.addMessage(to, sendJid, { id: msgId, fromMe: true, text, time: Date.now() });
    res.json({ ok: true, id: msgId });
  } catch (e) {
    console.error(`[PAINEL_ERR] ${e.message}`);
    // Fallback: tenta com @s.whatsapp.net se o sendJid era @lid
    if (sendJid !== to) {
      try {
        const sent2 = await globalSock?.sendMessage(to, { text });
        const msgId2 = sent2?.key?.id || `local_${Date.now()}`;
        store.addMessage(to, to, { id: msgId2, fromMe: true, text, time: Date.now() });
        return res.json({ ok: true, id: msgId2, via: 'fallback' });
      } catch (e2) {
        console.error(`[PAINEL_ERR_FALLBACK] ${e2.message}`);
      }
    }
    res.json({ ok: false, error: e.message });
  }
});

// Teste de entrega
app.get('/test', async (req, res) => {
  const { to, msg } = req.query;
  if (!to) return res.json({ error: 'Parâmetro ?to= obrigatório' });
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  try {
    const sent = await globalSock?.sendMessage(jid, { text: msg || 'Teste de entrega ✅' });
    res.json({ ok: true, jid, id: sent?.key?.id });
  } catch (e) {
    res.json({ ok: false, jid, error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`[PAINEL] http://localhost:${process.env.PORT || 3000}/panel`);
});

let globalSock = null;

// Cache @lid → senderPn e senderPn → @lid
const lidPhoneCache = new Map();
const phoneLidCache = new Map();

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

  globalSock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 ESCANEIE O QR CODE:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[WA] Conexão fechada. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
    if (connection === 'open') {
      console.log('[WA] ✅ Conectado! Painel disponível em /panel');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Aceita tanto notify (mensagens novas) quanto append (mensagens do histórico)
    for (const msg of messages) {
      try {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;
        if (remoteJid.endsWith('@g.us')) continue; // ignora grupos

        const isLid = remoteJid.endsWith('@lid');

        // Wave 1: CIPHERTEXT — guarda senderPn para usar como chave de sessão
        if (msg.messageStubType === 2 && isLid) {
          const keyJson = JSON.parse(JSON.stringify(msg.key));
          const senderPhone = keyJson.senderPn;
          if (senderPhone) {
            lidPhoneCache.set(remoteJid, senderPhone);
            phoneLidCache.set(senderPhone, remoteJid);
            // Cria a conversa no painel mesmo sem conseguir ler o texto
            store.getOrCreate(senderPhone, remoteJid);
            store.broadcast({ type: 'conv_update', conv: store.listConvs().find(c => c.phone === senderPhone) });
            console.log(`[LID_CACHE] ${remoteJid} → ${senderPhone} (wave1)`);
          }
          continue;
        }

        // Descarta outros stubs
        if (msg.messageStubType) continue;

        // Resolve phone e sendJid
        let phone, sendJid;
        if (isLid) {
          const keyJson = JSON.parse(JSON.stringify(msg.key));
          phone = keyJson.senderPn || lidPhoneCache.get(remoteJid) || remoteJid;
          sendJid = remoteJid;
        } else {
          phone = remoteJid;
          sendJid = phoneLidCache.get(phone) || phone;
        }

        // Extrai texto da mensagem
        const m = msg.message;
        const text =
          m?.conversation ||
          m?.extendedTextMessage?.text ||
          m?.imageMessage?.caption ||
          m?.videoMessage?.caption ||
          m?.ephemeralMessage?.message?.conversation ||
          m?.ephemeralMessage?.message?.extendedTextMessage?.text ||
          m?.buttonsResponseMessage?.selectedDisplayText ||
          m?.listResponseMessage?.title ||
          '';

        const fromMe = msg.key.fromMe === true;

        if (!text.trim()) continue;

        console.log(`[MSG] ${fromMe ? '←' : '→'} ${phone} "${text.substring(0, 60)}"`);

        // Salva no painel
        store.addMessage(phone, sendJid, {
          id: msg.key.id,
          fromMe,
          text: text.trim(),
          time: (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()),
        });

        // =====================================================
        // BOT AUTOMÁTICO DESATIVADO
        // Para reativar: descomentar o bloco abaixo
        // =====================================================
        // if (!fromMe) {
        //   await handleAutoBot(sock, phone, sendJid, text.trim());
        // }

      } catch (err) {
        console.error(`[MSG_ERR] ${err.message}`);
      }
    }
  });
}

startBot();
