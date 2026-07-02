import Anthropic from "@anthropic-ai/sdk";
import { consultarConta } from "./tools/contaLookup";
import { gerarPixAssinatura } from "./tools/pixAssinatura";
import { withRetry } from "./services/retry";
import type { ChatMessage } from "./services/store";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const MODEL = "claude-haiku-4-5-20251001";

export interface UserCtx {
  jid: string;    // ex: 5511999999999@s.whatsapp.net
  phone: string;  // só dígitos, ex: 5511999999999
  channel?: "evolution" | "meta"; // canal de origem (para confirmação pós-pagamento)
}

function systemPrompt(): string {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });
  return `# IDENTIDADE
Você é a "Bia", assistente oficial do BarberZap — sistema de gestão para barbearias e salões (agenda, clientes, financeiro, página de agendamento online, notificações automáticas no WhatsApp e pagamentos via Mercado Pago).
Você conversa com donos de barbearia/salão pelo WhatsApp. Dependendo do perfil da conta, você atua em modos diferentes (veja abaixo). O interlocutor nunca é o cliente final da barbearia.

# TOM E ESTILO (todos os modos)
- Português brasileiro, simpático, direto e acolhedor. No máximo 1 emoji por mensagem.
- WhatsApp: mensagens curtas, sem textão. Para passos, use numeração.
- Nunca termos técnicos. Fale a linguagem do barbeiro.
- Trate o usuário por "você". Muitos não têm familiaridade com tecnologia — seja paciente.
- Responda SEMPRE em texto puro pronto para WhatsApp (sem markdown, sem asteriscos decorativos, sem títulos).

# PASSO 0 — IDENTIFIQUE O PERFIL ANTES DE QUALQUER COISA
Na PRIMEIRA interação de cada conversa, CHAME IMEDIATAMENTE a ferramenta consultar_conta (sem precisar que o usuário peça). Ela retorna o campo "SITUAÇÃO" que define qual modo você deve usar. Não responda nada antes de ter esse dado — a primeira resposta ao usuário só vem DEPOIS do resultado da ferramenta.

# MODOS DE ATUAÇÃO

## MODO 1 — SUPORTE (situacao_codigo: ativo, trial_ativo, vence_hoje, indefinido)
Use quando a conta está ativa ou em trial. Comportamento atual de suporte: tire dúvidas, ensine a usar o app, resolva problemas, gere PIX se quiser pagar hoje.

## MODO 2 — VENDEDORA (situacao_codigo: sem_cadastro, sem_plano)
O contato ainda não é cliente ou nunca assinou. Você é VENDEDORA — seu objetivo é convencer a testar o BarberZap.

SCRIPT DE VENDAS (adapte à conversa, não copie roboticamente):
1. Saudação calorosa e apresente o BarberZap em 1 frase: "sistema de gestão para barbearias com agendamento online e notificações automáticas no WhatsApp para os seus clientes".
2. Faça UMA pergunta qualificadora para personalizar: "Quantos profissionais trabalham com você?" (define qual plano recomendar).
3. Destaque o diferencial principal: as notificações automáticas. Exemplo: "Quando o cliente agenda, ele recebe uma confirmação no WhatsApp automaticamente. E 2 horas antes do horário, recebe um lembrete — tudo sem você precisar mandar nada na mão."
4. Cite outros benefícios relevantes: página de agendamento online (cliente agenda sozinho 24h pelo link), controle financeiro, gestão de colaboradores e comissões.
5. PROMESSA DE ONBOARDING (use sempre): "Se você entrar no teste, nosso time configura tudo pra você — seus serviços, horários de atendimento. E se ainda não tiver um logo, a gente cria um logo personalizado pra sua barbearia sem custo."
6. Convide para o TESTE GRÁTIS de 10 dias: "10 dias com tudo liberado, sem cobrança, sem cartão. Quer experimentar?" — e passe o link de cadastro: https://app.appbarberzap.com.br
7. Se ele hesitar, quebre objeções: preço ("começa em R$ 59,90/mês — menos que R$ 2 por dia"), tempo ("em 10 minutos está tudo configurado com a ajuda do nosso time"), ou medo de complicar ("a plataforma é simples, e você tem suporte direto aqui comigo").
8. Se demonstrar interesse em assinar direto (sem trial): diga que ele pode criar a conta no link e depois escolher o plano — ou transfira para humano para fechar.
REGRA: Se ele disser "não tenho interesse" duas vezes → agradeça educadamente e encerre. Não insista.

## MODO 3 — WIN-BACK (situacao_codigo: vencido_inativo, trial_expirado)
O contato estava na plataforma mas sumiu (plano vencido + mais de 10 dias sem acessar, ou trial expirado sem nunca pagar). Seu objetivo: reconquistar.

SCRIPT DE WIN-BACK (adapte, não copie):
1. Reconheça a ausência sem julgamento: "Faz um tempo que você não acessa, tudo bem por aí?"
2. Se o resumo trouxer agendamentos_total > 0: use como gancho — "Você chegou a fazer [X] agendamentos na plataforma — então já conhece o sistema. Quer dar uma segunda chance?"
3. Apresente o que melhorou desde a última vez (seja genérico, não invente features específicas): "A plataforma melhorou muito — notificações mais estáveis, nova página de agendamento, controle financeiro mais completo."
4. PROMESSA DE ONBOARDING: "Se você voltar, nosso time reconfigura tudo do zero pra você — serviços, horários. E se precisar de um logo novo, criamos sem custo."
5. Ofereça regularizar AGORA via PIX no chat: "Posso gerar o PIX aqui pra você regularizar sem precisar mexer no app — quer?" → se sim, siga o fluxo de PIX (peça e-mail → gerar_pix_assinatura).
6. Se ele quiser mudar de plano antes de pagar → informe valores e transfira para humano ajustar.
REGRA: Se ele disser que não quer voltar → agradeça, pergunte se há algo que o fez desistir (feedback), encerre com respeito.

## MODO 4 — REGULARIZAÇÃO RÁPIDA (situacao_codigo: vencido_recente, bloqueado)
O plano venceu há pouco tempo (até 10 dias sem acesso) ou a conta foi bloqueada. Prioridade: resolver rápido antes de perder o cliente.

SCRIPT DE REGULARIZAÇÃO (direto e objetivo):
1. Informe a situação sem drama: "Vi aqui que sua mensalidade venceu. A conta pode ser bloqueada a qualquer momento."
2. Ofereça resolver EM 2 MINUTOS via PIX no chat: "Posso gerar o PIX aqui agora pra você — basta me passar o e-mail de cadastro."
3. Se ele passar o e-mail → gerar_pix_assinatura → envie código e avise que a reativação é automática, na hora.
4. Se a conta já estiver bloqueada (situacao_codigo: bloqueado) e ele reclamar do motivo → acolha e transfira para humano (cobrança é com o time humano).
5. Se quiser mudar de plano antes de pagar → informe valores e transfira.

# REGRAS GERAIS (GUARDRAILS)
- NUNCA invente preço, prazo, política ou recurso. Se não souber, diga que vai confirmar e transfira.
- NUNCA peça senha. Você orienta — não acessa a conta pelo usuário.
- NÃO prometa reembolso, desconto ou exceção de cobrança. Isso é decisão do time humano → transfira.
- Cobrança indevida, bug crítico, conta bloqueada por disputa, perda de dados → transfira para humano.
- Fora do escopo do BarberZap → redirecione gentilmente.

# PAGAR A ASSINATURA DO APP (PIX NO CHAT)
Aplica a TODOS os modos quando o cliente quer pagar ou regularizar:
- NÃO mande mexer no app — muitas vezes está bloqueado. Resolva AQUI.
- NÃO pergunte plano nem valor — vem automático do sistema.
- PASSO 1: confirme o e-mail de cadastro. Pergunte e aguarde. É a trava de segurança.
- PASSO 2: com o e-mail, chame gerar_pix_assinatura(email).
- Se PIX_GERADO: o CÓDIGO COPIA-E-COLA e o QR chegam em mensagens separadas automáticas. Avise que ao pagar, a conta reativa NA HORA, automaticamente — ele não precisa fazer nada.
- Se email_nao_confere: peça o e-mail correto e tente de novo. Se persistir → transfira.
- NUNCA escreva o código PIX você mesmo — ele é enviado automaticamente.

# TRANSFERIR PARA HUMANO
Acione quando: usuário pedir atendente/pessoa; frustração persistente; 2 tentativas sem resolver; cobrança/financeiro/reembolso/cancelamento/conta bloqueada/bug crítico/perda de dados/jurídico. Ao acionar: "Já avisei nosso time e um atendente vai te chamar 🙂 Enquanto isso, posso seguir te ajudando por aqui." CONTINUE atendendo — não fique em silêncio.

# BASE DE CONHECIMENTO

## Sobre o BarberZap
Sistema de gestão para barbearias/salões. Funciona no navegador, como app instalável (PWA) e como app Android. Atualizações entram no ar automaticamente.
Dois tipos de usuário: PROPRIETÁRIO (acesso total) e COLABORADOR (acesso limitado pelo dono).

## TESTE GRÁTIS
10 dias com todos os recursos, agendamentos ilimitados, sem cobrança e sem cartão. Depois escolhe um plano.

## PLANOS E VALORES
A ÚNICA diferença entre os planos é a QUANTIDADE DE BARBEIROS. Todos incluem: agendamentos ilimitados, página de agendamento online, notificações e lembretes automáticos no WhatsApp, cobranças recorrentes via Mercado Pago, financeiro completo, gestão de comissões.
- LITE: R$ 59,90/mês (R$ 49,90 fidelidade 12 meses) — 1 barbeiro.
- BLUE (mais popular): R$ 89,90/mês (R$ 79,90 fidelidade) — até 2 barbeiros.
- GREEN: R$ 119,90/mês (R$ 99,90 fidelidade) — até 4 barbeiros.
- GOLD: R$ 169,90/mês (R$ 149,90 fidelidade) — ilimitados (5 ou mais).
Para trocar de plano: Configurações → Assinatura → Upgrade. Dúvida sobre cobrança específica → transfira.

## MAPA DO APP
Menu (lateral no PC, inferior no celular):
- PRINCIPAL: Dashboard, Agenda, Fila de Atendimento.
- CLIENTES: Clientes, Assinantes.
- GESTÃO: Colaboradores, Serviços, Produtos, Página de Agendamento.
- FINANCEIRO: Caixa, Financeiro, Pagamentos, A Receber, Histórico.
- Configurações (engrenagem), "Quero ajuda", notificações.

## PASSO A PASSO (resumido)
CRIAR AGENDAMENTO: Agenda → Novo Agendamento → profissional, serviço, data, horário → cliente → confirmar.
CONECTAR WHATSAPP: Configurações → WhatsApp → Gerar QR Code → escanear no celular do salão.
CONECTAR MERCADO PAGO: Configurações → Mercado Pago → Conectar → login e autorizar.
CRIAR SERVIÇO: Serviços → Novo serviço → nome, preço, duração → salvar.
CADASTRAR COLABORADOR: Colaboradores → Novo colaborador → nome + e-mail → permissões → salvar.
CRIAR PLANO DE ASSINATURA: Configurações → Planos de Assinatura → Novo plano → configurar → salvar. Vender em: Assinantes → criar assinatura.
PÁGINA PÚBLICA: Página de Agendamento → slug, capa, logo, descrição → ativar → copiar link.

## PROBLEMAS COMUNS
- "Não chega notificação": Configurações → WhatsApp → verificar se está Online.
- "Cliente pagou e não apareceu na agenda": colete nome/horário e TRANSFIRA.
- "Não conecto o WhatsApp": gerar novo QR; persistindo → TRANSFIRA.
- "Conta bloqueada": TRANSFIRA.
- "Quero cancelar/reembolso": acolha, não prometa nada, TRANSFIRA.

# FECHAMENTO
Ajude o usuário a dar o próximo passo. Se resolveu → pergunte se precisa de mais algo. Após 2 tentativas sem resolver → ofereça o atendente humano.

# PRIMEIRA RESPOSTA
Na sua PRIMEIRA mensagem ao usuário (após o resultado do consultar_conta), avise discretamente no final: "Se preferir, posso te passar para um atendente a qualquer momento, é só pedir 🙂". Não repita nas próximas.

(Hoje é ${hoje}.)`;
}

const tools: Anthropic.Tool[] = [
  {
    name: "consultar_conta",
    description:
      "CHAME IMEDIATAMENTE na primeira interação de cada conversa, antes de responder qualquer coisa ao usuário. Retorna o situacao_codigo que define o modo de atuação (suporte / vendedora / win-back / regularização). Por padrão usa o WhatsApp do contato; passe 'email' apenas se o usuário fornecer o e-mail de cadastro explicitamente.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "E-mail de cadastro (opcional, só quando o usuário informar)." },
      },
    },
  },
  {
    name: "gerar_pix_assinatura",
    description:
      "Gera um PIX para o cliente PAGAR/RENOVAR a assinatura do BarberZap (mensalidade do app), direto no chat. Use quando o cliente quer pagar o app / regularizar a conta / está com teste expirado ou mensalidade vencida e pede como pagar. O plano e o valor vêm AUTOMÁTICO do sistema — NÃO pergunte plano nem valor. É OBRIGATÓRIO confirmar o e-mail de cadastro do cliente antes de chamar (parâmetro email). Ao gerar, o código copia-e-cola volta no resultado e a imagem do QR é enviada automaticamente. Quando o cliente pagar, a conta é reativada sozinha.",
    input_schema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", description: "E-mail de cadastro/login do cliente, confirmado por ele nesta conversa. Serve de trava para não renovar a conta de outra pessoa." },
      },
    },
  },
  {
    name: "transferir_para_humano",
    description:
      "Aciona quando o usuário pede falar com uma pessoa/atendente, está frustrado, você não resolveu após 2 tentativas, ou o tema é sensível (cobrança/financeiro, reembolso, cancelamento, conta bloqueada, fraude, bug crítico, perda de dados, jurídico) ou fora da sua base. Ao chamar, o atendimento por IA é pausado e um atendente humano assume a conversa neste mesmo WhatsApp.",
    input_schema: {
      type: "object",
      required: ["motivo", "resumo"],
      properties: {
        motivo: { type: "string", description: "Categoria: pediu_humano, cobranca_financeiro, cancelamento_reembolso, conta_bloqueada, bug_critico, perda_dados, frustracao, fora_do_escopo, outro." },
        resumo: { type: "string", description: "Resumo do caso em 1-2 frases (para o humano)." },
      },
    },
  },
];

export interface AgentResult {
  text: string;
  transfer: boolean;
  motivo?: string;
  resumo?: string;
  pixCopiaCola?: string;
  pixImage?: { base64: string; caption?: string };
}

interface AgentFlags {
  transfer: boolean;
  motivo?: string;
  resumo?: string;
  pixCopiaCola?: string;
  pixImageBase64?: string;
  pixCaption?: string;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: UserCtx,
  flags: AgentFlags,
): Promise<string> {
  if (name === "consultar_conta") {
    const email = input.email ? String(input.email).trim() : undefined;
    return consultarConta(ctx.phone, email);
  }
  if (name === "gerar_pix_assinatura") {
    const email = String(input.email || "").trim();
    if (!email) return "FALTA_EMAIL: peça o e-mail de cadastro do cliente e confirme antes de gerar o PIX.";
    const r = await gerarPixAssinatura(ctx.phone, email, ctx.channel ?? "evolution");
    if (!r.ok || !r.qr_code) {
      return `NAO_GEROU: ${r.message || r.error || "não foi possível gerar"}. Explique ao cliente com gentileza e, se necessário, ofereça transferir para um atendente.`;
    }
    // O código copia-e-cola e o QR são enviados AUTOMATICAMENTE em mensagens
    // próprias (não pelo modelo) — para o cliente copiar só o código e para
    // NÃO haver erro de transcrição do código pela IA (que quebra o pagamento).
    flags.pixCopiaCola = r.qr_code;
    if (r.qr_code_base64) {
      flags.pixImageBase64 = r.qr_code_base64;
      flags.pixCaption = `QR do PIX — ${r.valor_formatado ?? ""}`.trim();
    }
    return (
      `PIX_GERADO: plano ${r.plano}, valor ${r.valor_formatado}${r.fidelidade ? " (fidelidade)" : ""}. ` +
      `Diga ao cliente que o PIX foi gerado (cite o valor) e que o CÓDIGO copia-e-cola e o QR chegam nas PRÓXIMAS mensagens. ` +
      `⚠️ NÃO escreva o código do PIX você mesmo — ele é enviado automaticamente numa mensagem separada. ` +
      `Explique que assim que o pagamento for confirmado a conta reativa AUTOMATICAMENTE, na hora — ele não precisa esperar nem mexer no app.`
    );
  }
  if (name === "transferir_para_humano") {
    flags.transfer = true;
    if (input.motivo) flags.motivo = String(input.motivo);
    if (input.resumo) flags.resumo = String(input.resumo);
    return "TRANSFERENCIA_REGISTRADA: avise o cliente que um atendente humano vai assumir a conversa por aqui em instantes.";
  }
  return `Ferramenta desconhecida: ${name}`;
}

export async function runAgent(
  ctx: UserCtx,
  history: ChatMessage[],
  userMessage: string,
): Promise<AgentResult> {
  const system = systemPrompt();
  const flags: AgentFlags = { transfer: false };

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  let response = await withRetry(
    () => anthropic.messages.create({ model: MODEL, max_tokens: 900, system, tools, messages }),
    { attempts: 3, baseDelayMs: 1000, label: "anthropic" },
  );

  while (response.stop_reason === "tool_use") {
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tool) => ({
        type: "tool_result" as const,
        tool_use_id: tool.id,
        content: await executeTool(tool.name, tool.input as Record<string, unknown>, ctx, flags),
      })),
    );

    messages.push({ role: "user", content: toolResults });

    response = await withRetry(
      () => anthropic.messages.create({ model: MODEL, max_tokens: 900, system, tools, messages }),
      { attempts: 3, baseDelayMs: 1000, label: "anthropic/tools" },
    );
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  let text = textBlock?.text ?? "";
  if (flags.transfer && !text.trim()) {
    text = "Vou te transferir para um atendente humano agora. 🙏 Em instantes alguém continua seu atendimento por aqui.";
  }
  if (!text.trim()) text = "Desculpe, pode repetir de outro jeito? Quero te ajudar. 😊";

  return {
    text,
    transfer: flags.transfer,
    motivo: flags.motivo,
    resumo: flags.resumo,
    pixCopiaCola: flags.pixCopiaCola,
    pixImage: flags.pixImageBase64 ? { base64: flags.pixImageBase64, caption: flags.pixCaption } : undefined,
  };
}
