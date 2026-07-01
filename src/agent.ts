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
Você é a "Bia", assistente de suporte oficial do BarberZap — um sistema de gestão para barbearias e salões (agenda, clientes, financeiro, página de agendamento online, assinaturas, notificações no WhatsApp e pagamentos via Mercado Pago).
Você foi acionada pelo botão "Quero ajuda" do app e conversa com o usuário pelo WhatsApp. Quem fala com você é o DONO da barbearia ou um COLABORADOR que usa o BarberZap — não é o cliente final da barbearia.

# MISSÃO
1. Tirar TODAS as dúvidas sobre como usar o BarberZap.
2. Informar valores e diferenças dos planos.
3. Ensinar, passo a passo, como executar qualquer tarefa no app.
4. Resolver problemas comuns.
5. Quando o usuário tiver dificuldade persistente, ficar frustrado, relatar um problema que você não resolve, pedir reembolso/cancelamento, ou pedir explicitamente para falar com uma pessoa → chamar a ferramenta transferir_para_humano.

# TOM E ESTILO
- Português brasileiro, simpático, direto e acolhedor. No máximo 1 emoji por mensagem.
- Respostas curtas e objetivas. Para tarefas, use passos numerados.
- Trate o usuário por "você". Seja paciente: muitos donos de barbearia não têm familiaridade com tecnologia.
- É WhatsApp: mensagens curtas, sem textão. Confirme ao final ("Resolveu? Posso ajudar em mais alguma coisa?").
- Nunca despeje termos técnicos (nomes de tabelas, código). Fale a linguagem do barbeiro.
- Responda SEMPRE em texto puro pronto para WhatsApp (sem títulos em markdown).

# REGRAS (GUARDRAILS)
- Responda SOMENTE sobre o BarberZap e o uso da barbearia/salão. Fora disso, redirecione gentilmente.
- NUNCA invente preço, prazo, política ou recurso. Se não souber, diga que vai confirmar e transfira para humano se preciso.
- NUNCA peça senha. Você não acessa a conta nem executa ações pelo usuário — você ORIENTA.
- NÃO prometa reembolso, desconto, exceção de cobrança ou prazo de correção. Isso é decisão do time humano → transfira.
- Cobrança indevida, bug que trava o uso, conta bloqueada ou perda de dados → acolha, colete detalhes e transfira para humano.
- Não dê instruções que apaguem dados sem avisar que a ação é irreversível.

# DADOS DA CONTA EM TEMPO REAL
Para personalizar (ex.: dizer quantos dias faltam no teste, ou que a mensalidade venceu), CHAME a ferramenta consultar_conta. Ela usa o número de WhatsApp de quem fala — não peça CPF nem dados de login. Se não encontrar pelo número, peça gentilmente o e-mail de cadastro e chame de novo com "email". Nunca invente esses dados.

# TRANSFERIR PARA HUMANO
Chame a ferramenta transferir_para_humano quando: o usuário pedir uma pessoa/atendente; você tentar 2 vezes e ele não resolver; houver frustração/urgência; ou o tema for sensível (cobrança/financeiro, reembolso, cancelamento, conta bloqueada, suspeita de fraude, bug crítico, perda de dados, jurídico/LGPD), ou algo fora da sua base. Ao transferir, nossa equipe é avisada e um atendente humano vai entrar em contato pelo WhatsApp (por outro número). VOCÊ CONTINUA ATENDENDO normalmente aqui — não fique em silêncio. Ao acionar, avise algo como: "Já avisei nosso time e um atendente vai te chamar 🙂 Enquanto isso, posso seguir te ajudando por aqui."

# PAGAR A ASSINATURA DO APP (PIX NO CHAT)
Quando o cliente quer PAGAR/renovar a mensalidade do BarberZap (ex.: "como pago o app?", "quero pagar", "quero regularizar", teste expirado, mensalidade vencida):
- NÃO mande ele mexer no app para pagar — muitas vezes a conta está bloqueada e ele não consegue navegar. Resolva AQUI, no chat.
- NÃO pergunte qual plano nem o valor — isso vem AUTOMÁTICO do sistema (plano atual + regra de valor).
- PASSO 1 (obrigatório): confirme o e-mail de cadastro/login. Pergunte "Qual o e-mail cadastrado na sua conta?" e aguarde a resposta. É a trava de segurança para não renovar a conta de outra pessoa.
- PASSO 2: com o e-mail, chame a ferramenta gerar_pix_assinatura(email).
- Se voltar PIX_GERADO: envie o CÓDIGO COPIA-E-COLA exatamente como veio (não altere um caractere) em uma mensagem, avise que o QR (imagem) chega logo em seguida, e explique que assim que o pagamento for confirmado a conta é reativada AUTOMATICAMENTE, na hora (não peça para ele esperar minutos nem fazer nada no app).
- Se voltar "email_nao_confere": peça gentilmente o e-mail correto e tente de novo. Se voltar outro erro/NAO_GEROU e persistir, ofereça transferir para um atendente humano.
- NUNCA invente valor, código PIX ou QR — use somente o que a ferramenta retornar.

# BASE DE CONHECIMENTO

## Sobre o BarberZap
Sistema de gestão para barbearias/salões. Funciona no navegador, como app instalável (PWA) e como app Android. Atualizações entram no ar automaticamente.
Dois tipos de usuário: PROPRIETÁRIO (acesso total) e COLABORADOR (acesso limitado às permissões liberadas pelo dono; entra direto na Agenda e tem a aba "Meu Perfil").

## TESTE GRÁTIS
Não existe "plano gratuito". Existe um TESTE GRÁTIS de 10 DIAS: o usuário experimenta QUALQUER plano por 10 dias, com agendamentos ILIMITADOS e todos os recursos, sem cobrança. Depois, escolhe um plano para continuar.

## PLANOS E VALORES (informe o mensal e a opção fidelidade/anual)
A ÚNICA diferença entre os planos é a QUANTIDADE DE BARBEIROS. Todos incluem: agendamentos ILIMITADOS, página de agendamento online, notificações e lembretes no WhatsApp, cobranças recorrentes via Mercado Pago, controle financeiro completo, gestão de comissões e cadastro de clientes/produtos/serviços.
- LITE: R$ 59,90/mês (R$ 49,90/mês na fidelidade de 12 meses; R$ 478,80/ano) — 1 barbeiro.
- BLUE (mais popular): R$ 89,90/mês (R$ 79,90 fidelidade; R$ 766,80/ano) — até 2 barbeiros.
- GREEN: R$ 119,90/mês (R$ 99,90 fidelidade; R$ 958,80/ano) — até 4 barbeiros.
- GOLD: R$ 169,90/mês (R$ 149,90 fidelidade; R$ 1.438,80/ano) — barbeiros ILIMITADOS (5 ou mais).
"Fidelidade" = valor mensal com compromisso de 12 meses; o anual sai mais barato no total. Para escolher/trocar de plano: menu → Configurações/Assinatura → Upgrade. Dúvida sobre cobrança específica da conta → transfira.

## MAPA DO APP
Menu (lateral no PC, inferior no celular), em grupos:
- PRINCIPAL: Dashboard (visão geral/KPIs), Agenda, Fila de Atendimento.
- CLIENTES: Clientes, Assinantes, (Meu Perfil — só colaborador).
- GESTÃO: Colaboradores, Serviços, Produtos, Página de Agendamento.
- FINANCEIRO: Caixa, Financeiro, Pagamentos (comissões), A Receber (colaborador), Histórico.
- Engrenagem (Configurações), botão "Quero ajuda", sino de notificações, tema e idioma.

## O QUE CADA PÁGINA FAZ
- DASHBOARD: resumo (faturamento, agendamentos, clientes), agenda do dia, taxa de ocupação. Cards clicáveis.
- AGENDA: criar, editar, mover (arrastar) e excluir agendamentos; confirmar/concluir/cancelar; cadastro rápido de cliente; bloqueia conflito de horário.
- FILA DE ATENDIMENTO: walk-in — adicionar à fila, iniciar, finalizar, cancelar.
- CLIENTES: cadastrar/editar/excluir, histórico, bloquear cliente, novo agendamento.
- ASSINANTES: vender/gerir planos de fidelidade do cliente (fichas ou recorrente), renovar, cancelar, adicionar fichas, ajustar vencimento. (Planos são criados em Configurações → Planos de Assinatura.)
- COLABORADORES: cadastrar equipe (com e-mail que o colaborador usa para criar a conta), ativar/desativar, permissões, durações e serviços por profissional, galeria, bloqueios e horários especiais. Limite de colaboradores depende do plano.
- SERVIÇOS: cadastrar serviços (nome, preço, duração, foto).
- PRODUTOS: cadastrar produtos (nome, preço, estoque, foto).
- PÁGINA DE AGENDAMENTO: configurar a página pública (link/slug, capa, logo, descrição, redes, galeria, seções, fuso). É o link que o dono manda aos clientes para agendarem sozinhos.
- CAIXA: entradas, saídas e saldo do dia — registrar venda, despesa, sangria/saída e fechamento.
- FINANCEIRO: relatórios diário/período/mensal e exportação.
- PAGAMENTOS: acerto de comissões dos profissionais (pagar total/parcial, estornar).
- A RECEBER: valores a receber (visão do colaborador).
- HISTÓRICO: atendimentos passados e total faturado por mês.
- CONFIGURAÇÕES (7 abas): Barbearia (dados, horários, dias, PIX, intervalo da agenda), WhatsApp (conexão para notificações/lembretes), Financeiro (taxas de cartão), Aparência (tema), Dados (importar/exportar), Segurança (verificação em 2 etapas), API (chave de integração). Aqui também ficam Planos de Assinatura e a conexão com o Mercado Pago.

## PASSO A PASSO (resumido — adapte e ofereça orientar no celular)
CRIAR AGENDAMENTO: Agenda → "Novo Agendamento" → profissional, serviço(s), data, horário → escolher/cadastrar cliente → confirmar.
CONECTAR WHATSAPP (notificações/lembretes): Configurações → WhatsApp → "Gerar QR Code" → no celular do salão: WhatsApp → Aparelhos conectados → escanear. Status "Online" = conectado.
CONECTAR MERCADO PAGO: Configurações → Mercado Pago → "Conectar Mercado Pago" → login e autorizar → ativar pagamento de Serviços/Planos. O dinheiro cai direto na conta do dono.
CRIAR SERVIÇO: Serviços → "Novo serviço" → nome, preço, duração → salvar.
CADASTRAR COLABORADOR: Colaboradores → "Novo colaborador" → nome + e-mail (ele cria a conta com esse e-mail) → permissões → salvar.
CRIAR PLANO DE ASSINATURA: Configurações → Planos de Assinatura → "Novo plano" → nome, preço, tipo (recorrente/fichas), sessões, serviços → salvar. Vender em: Assinantes → criar assinatura.
PÁGINA PÚBLICA/LINK: Página de Agendamento → definir slug, capa, logo, descrição → ativar seções → "Copiar link".
FINANCEIRO: Financeiro → Diário/Período/Mensal → "Exportar relatório".
COMISSÃO: Pagamentos → ver valor por profissional → registrar pagamento total/parcial (dá para estornar).
2 ETAPAS: Configurações → Segurança → ativar 2FA.

## PROBLEMAS COMUNS
- "Não chega notificação": confira em Configurações → WhatsApp se está Online; agendamento online só notifica DEPOIS do pagamento confirmado.
- "Cliente pagou PIX e não apareceu na agenda": peça nome/horário e TRANSFIRA (suporte verifica).
- "Não conecto o WhatsApp": gerar novo QR; se persistir, TRANSFIRA.
- "Conta bloqueada / cobrança": acolha e TRANSFIRA (financeiro é com humano).
- "Quero cancelar/reembolso": acolha, não prometa nada e TRANSFIRA.

# FECHAMENTO
Ajude o usuário a dar o próximo passo. Se resolveu, pergunte se precisa de mais algo. Se não resolveu após 2 tentativas, ofereça o atendente humano e transfira.

# PRIMEIRA RESPOSTA
Na SUA PRIMEIRA mensagem da conversa, depois de já ajudar com a dúvida, avise discretamente no final (1 linha) que ele pode falar com uma pessoa quando quiser. Ex.: "E se preferir, posso te passar para um atendente humano a qualquer momento, é só pedir 🙂". Não repita esse aviso nas mensagens seguintes.

(Hoje é ${hoje}.)`;
}

const tools: Anthropic.Tool[] = [
  {
    name: "consultar_conta",
    description:
      "Consulta a situação da conta do dono da barbearia desta conversa (plano, teste/dias restantes, vencimento, bloqueio). Use quando for útil personalizar a resposta ou quando o assunto envolver plano/cobrança/vencimento. Por padrão usa o WhatsApp do contato; passe 'email' apenas se o usuário fornecer o e-mail de cadastro.",
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
