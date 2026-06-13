# Como subir o Agente CNH no Railway (100% grátis)

## PASSO 1 — Pegar chave Groq (IA grátis)
1. Acesse https://console.groq.com
2. Crie conta gratuita
3. Vá em "API Keys" → "Create API Key"
4. Copie a chave (começa com `gsk_`)

## PASSO 2 — Subir no Railway

### 2.1 — Evolution API
1. Acesse https://railway.app → New Project → Deploy from Template
2. Busque "Evolution API" no marketplace
3. Após deploy, anote a URL (ex: `https://evolution-xxx.railway.app`)
4. Acesse a URL + `/manager` para criar uma instância
5. Conecte o WhatsApp escaneando o QR Code

### 2.2 — Este agente
1. Crie uma pasta, coloque estes arquivos
2. Inicie git: `git init && git add . && git commit -m "init"`
3. No Railway: New Project → Deploy from GitHub repo
4. Conecte o repositório

### 2.3 — Variáveis de ambiente no Railway
No painel do seu serviço → Variables → adicione:

```
GROQ_API_KEY=gsk_sua_chave_aqui
EVOLUTION_API_URL=https://sua-evolution.railway.app
EVOLUTION_API_KEY=chave_da_evolution
EVOLUTION_INSTANCE=nome_da_instancia
ATENDENTE_NUMERO=5511999999999
WEBHOOK_SECRET=qualquer_senha
PORT=3000
```

## PASSO 3 — Configurar Webhook na Evolution API

Acesse: `https://sua-evolution.railway.app/webhook/set/NOME_DA_INSTANCIA`

Payload:
```json
{
  "url": "https://seu-agente.railway.app/webhook",
  "webhook_by_events": false,
  "webhook_base64": false,
  "events": ["MESSAGES_UPSERT"]
}
```

Ou via painel Evolution: Settings → Webhook → URL do agente + `/webhook`

## PASSO 4 — Testar
Mande uma mensagem pro número conectado e o agente responde automaticamente!

---

## Limites gratuitos
- **Railway**: $5/crédito/mês (suficiente pra ~500h de execução)
- **Groq**: 14.400 requisições/dia grátis (mais que suficiente)
- **Evolution API**: Grátis (open source)
