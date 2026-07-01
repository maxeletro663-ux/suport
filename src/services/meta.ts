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

// Baixa uma mídia recebida (ex.: áudio) pela Cloud API e devolve base64.
// Fluxo: media_id -> GET metadados (url) -> GET binário (com Bearer) -> base64.
export async function metaDownloadMedia(mediaId: string): Promise<string | null> {
  const tok = token();
  if (!mediaId || !tok) return null;
  try {
    const meta = await axios.get(
      `https://graph.facebook.com/${API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${tok}` }, timeout: 20_000 },
    );
    const url = meta.data?.url;
    if (!url) {
      console.error("[suporte][meta] mídia sem url:", meta.data);
      return null;
    }
    const bin = await axios.get(url, {
      headers: { Authorization: `Bearer ${tok}` },
      responseType: "arraybuffer",
      timeout: 30_000,
    });
    return Buffer.from(bin.data).toString("base64");
  } catch (e: any) {
    console.error("[suporte][meta] erro ao baixar mídia:", e?.response?.data ?? e?.message ?? e);
    return null;
  }
}

// Envia imagem via Cloud API: faz upload do base64 -> media id -> envia.
export async function metaSendImage(to: string, base64: string, caption = ""): Promise<void> {
  const pid = phoneId();
  const tok = token();
  if (!pid || !tok) {
    console.warn("[suporte][meta] envio de imagem pulado — faltam credenciais");
    return;
  }
  try {
    // 1) upload da mídia
    const bytes = Buffer.from(base64, "base64");
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "image/png");
    form.append("file", new Blob([bytes], { type: "image/png" }), "pix-qr.png");

    const up = await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${pid}/media`,
      form,
      { headers: { Authorization: `Bearer ${tok}` }, timeout: 30_000 },
    );
    const mediaId = up.data?.id;
    if (!mediaId) {
      console.error("[suporte][meta] upload sem media id:", up.data);
      return;
    }

    // 2) envia a imagem pelo media id
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${pid}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: { id: mediaId, caption },
      },
      { headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, timeout: 30_000 },
    );
  } catch (e: any) {
    console.error("[suporte][meta] erro no envio de imagem:", e?.response?.data ?? e?.message ?? e);
  }
}

// Envia imagem via Cloud API a partir de uma URL pública (sem upload).
export async function metaSendImageUrl(to: string, url: string, caption = ""): Promise<void> {
  const pid = phoneId();
  const tok = token();
  if (!pid || !tok) {
    console.warn("[suporte][meta] envio de imagem (url) pulado — faltam credenciais");
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${pid}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: { link: url, caption },
      },
      { headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, timeout: 30_000 },
    );
  } catch (e: any) {
    console.error("[suporte][meta] erro no envio de imagem (url):", e?.response?.data ?? e?.message ?? e);
  }
}
