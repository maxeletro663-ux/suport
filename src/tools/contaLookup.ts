import axios from "axios";

// Ferramenta `consultar_conta`: consulta a situação da conta do dono da
// barbearia chamando a edge function segura da plataforma BarberZap
// (cliente-contexto). Identificação por telefone (já autenticado pelo WhatsApp);
// e-mail é fallback quando o número não bate.

interface ContextoResponse {
  found: boolean;
  nome_salao?: string;
  plano?: string;
  situacao?: string;
  resumo?: string;
}

export async function consultarConta(phone: string, email?: string): Promise<string> {
  const base   = process.env.BARBERZAP_API_URL;
  const secret = process.env.AGENT_LOOKUP_SECRET;
  if (!base || !secret) return "Erro de configuração: BARBERZAP_API_URL/AGENT_LOOKUP_SECRET ausentes.";

  const body = email ? { email } : { phone };

  try {
    const res = await axios.post<ContextoResponse>(
      `${base}/functions/v1/cliente-contexto?secret=${encodeURIComponent(secret)}`,
      body,
      { headers: { "Content-Type": "application/json" }, timeout: 20_000 },
    );
    // O `resumo` já vem pronto para injetar no raciocínio do agente.
    return res.data?.resumo
      ?? (res.data?.found ? "Conta encontrada, mas sem detalhes." : "Conta não encontrada por este número.");
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? `HTTP ${err.response?.status ?? "?"} ${JSON.stringify(err.response?.data ?? err.message)}`
      : err instanceof Error ? err.message : String(err);
    console.error("[consultar_conta] erro:", msg);
    return `Não consegui consultar os dados da conta agora (${msg}). Ajude mesmo assim e, se for sobre cobrança/conta, ofereça transferir para humano.`;
  }
}
