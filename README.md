# BarberZap — Agente de Suporte (WhatsApp)

Agente de IA de **suporte** do BarberZap, acionado pelo botão **"Quero ajuda"** do app.
É um serviço **standalone** (Node + TypeScript + Fastify), separado da plataforma —
mesma estrutura dos outros agentes (lovetag/chakal). Os dados do cliente são
consultados **em tempo real** numa edge function da plataforma BarberZap.

## Como funciona
- Recebe o webhook da Evolution (`messages.upsert`) da instância do número de suporte ("Ativa").
- **Ativa** o atendimento só quando o cliente manda a frase do botão (`ACTIVATION_PHRASE`).
  Depois, continua atendendo o número até a sessão expirar (3h deslizante).
- Se um **humano** responder pelo número de suporte → IA **pausa** (`HUMAN_PAUSE_MINUTES`).
- Identifica a conta pelo número do WhatsApp via tool `consultar_conta` →
  edge function `cliente-contexto` (plano, teste/dias, vencimento, bloqueio).
- Tool `transferir_para_humano` pausa a IA para um atendente assumir.
- Histórico/lock/debounce/rate-limit no **Upstash Redis** (fallback em memória).

## Rodar local
```bash
cp .env.example .env   # preencha as variáveis
npm install
npm run dev
```
Webhook local: `POST http://localhost:3000/webhook` · Health: `GET /health`.

## Deploy (EasyPanel, Docker)
1. Suba este repositório no GitHub.
2. No EasyPanel: **App** → source = este repo → build pelo `Dockerfile` (porta 3000).
3. Configure as variáveis de ambiente (ver `.env.example`).
4. Pegue a URL pública do app (ex.: `https://barberzap-suporte.easypanel.host`).
5. Na Evolution, na instância **"Ativa"**, aponte o webhook para `SUA_URL/webhook`
   com o evento **`MESSAGES_UPSERT`** ligado e "Webhook by Events" desligado.

## Variáveis de ambiente
Ver `.env.example`. Resumo:
- `ANTHROPIC_API_KEY` — chave própria do agente (crédito isolado).
- `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` / `EVOLUTION_INSTANCE` (= `Ativa`).
- `BARBERZAP_API_URL` (base das edge functions Supabase) / `AGENT_LOOKUP_SECRET`.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (recomendado).
- `ACTIVATION_PHRASE` / `HUMAN_PAUSE_MINUTES` / `PORT`.

> A plataforma BarberZap precisa ter a edge function `cliente-contexto` deployada
> e o secret `AGENT_LOOKUP_SECRET` configurado com o MESMO valor usado aqui.
