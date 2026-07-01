import axios from "axios";

// Ferramenta `gerar_pix_assinatura`: chama a edge function segura
// (agent-subscription-pix) que confirma o e-mail, aplica a regra de valor do
// sistema (custom > 0 senão plano por CPF/fidelidade) e gera o PIX de 1 mês.

export interface PixResult {
  ok: boolean;
  error?: string;
  message?: string;
  plano?: string;
  fidelidade?: boolean;
  valor?: number;
  valor_formatado?: string;
  qr_code?: string;          // copia-e-cola
  qr_code_base64?: string;   // imagem PNG (base64)
  payment_id?: string;
}

export async function gerarPixAssinatura(
  phone: string,
  email: string,
  channel: "evolution" | "meta" = "evolution",
): Promise<PixResult> {
  const base = process.env.BARBERZAP_API_URL;
  const secret = process.env.AGENT_LOOKUP_SECRET;
  if (!base || !secret) return { ok: false, message: "Erro de configuração (BARBERZAP_API_URL/AGENT_LOOKUP_SECRET)." };

  try {
    const res = await axios.post<PixResult>(
      `${base}/functions/v1/agent-subscription-pix?secret=${encodeURIComponent(secret)}`,
      { phone, email, channel },
      { headers: { "Content-Type": "application/json" }, timeout: 25_000 },
    );
    return res.data;
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data as PixResult | undefined)?.message ?? `HTTP ${err.response?.status ?? "?"}`
      : err instanceof Error ? err.message : String(err);
    console.error("[gerar_pix_assinatura] erro:", detail);
    return { ok: false, message: `Falha técnica ao gerar o PIX (${detail}).` };
  }
}
