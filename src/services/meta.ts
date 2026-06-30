import axios from "axios";

// ── Cloud API oficial (Meta WhatsApp) ──────────────────────────────────
// Usada quando o suporte é acionado pelo botão da NOTIFICAÇÃO (número da API
// oficial). O mesmo cérebro da Bia responde por aqui via Graph API.
const API_VERSION = process.env.META_API_VERSION ?? "v21.0";
const phoneId = () => process.env.META_PHONE_NUMBER_ID ?? "";
const token = () => process.env.META_ACCESS_TOKEN ?? "";

export const metaVerifyToken = () => process.env.META_VERIFY_TOKEN ?? "";
export const metaConfigured = () => !!(phoneId() && token());

export async function metaSendText(to: string, text: string): Promise<void> {
  if (!metaConfigured()) {
    console.warn("[suporte][meta] envio pulado — faltam META_PHONE_NUMBER_ID/META_ACCESS_TOKEN");
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${phoneId()}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: true, body: text },
      },
      {
        headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        timeout: 30_000,
      },
    );
  } catch (e: any) {
    console.error("[suporte][meta] erro no envio:", e?.response?.data ?? e?.message ?? e);
  }
}
