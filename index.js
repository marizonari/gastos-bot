const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "50mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Categorias reconhecidas
const CATEGORIAS = [
  "mercado", "restaurante", "farmácia", "transporte",
  "conta", "lazer", "delivery", "academia", "outro"
];

// Salva gasto na planilha
async function salvarGasto(data, quem, valor, categoria, descricao) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Gastos!A:E",
    valueInputOption: "USER_ENTERED",
    resource: {
      values: [[data, quem, valor, categoria, descricao]],
    },
  });
}

// Busca todos os gastos do mês atual
async function buscarGastosMes() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Gastos!A:E",
  });
  const rows = res.data.values || [];
  const mesAtual = new Date().toISOString().slice(0, 7); // "2025-04"

  return rows.filter(r => r[0] && r[0].startsWith(mesAtual));
}

// Monta resumo formatado
async function montarResumo() {
  const gastos = await buscarGastosMes();
  if (gastos.length === 0) return "Nenhum gasto registrado este mês ainda.";

  const totais = {};
  const categorias = {};

  for (const [, quem, valor, categoria] of gastos) {
    const v = parseFloat(valor);
    totais[quem] = (totais[quem] || 0) + v;
    categorias[categoria] = (categorias[categoria] || 0) + v;
  }

  const total = Object.values(totais).reduce((a, b) => a + b, 0);

  const emojiCat = {
    mercado: "🛒", restaurante: "🍽️", farmácia: "💊",
    transporte: "🚗", conta: "💡", lazer: "🎉",
    delivery: "🛵", academia: "🏋️", outro: "📦"
  };

  let msg = `📊 *Resumo do mês:*\n`;
  for (const [quem, val] of Object.entries(totais)) {
    msg += `${quem}: R$ ${val.toFixed(2)}\n`;
  }
  msg += `─────────────────\n`;
  msg += `*Total: R$ ${total.toFixed(2)}*\n\n`;
  msg += `🏷️ *Por categoria:*\n`;
  for (const [cat, val] of Object.entries(categorias)) {
    msg += `${emojiCat[cat] || "📦"} ${cat}: R$ ${val.toFixed(2)}\n`;
  }

  return msg;
}

// Envia mensagem no WhatsApp
async function enviarMensagem(groupId, texto) {
  await axios.post(
    `${process.env.EVOLUTION_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
    { number: groupId, text: texto },
    { headers: { apikey: process.env.EVOLUTION_API_KEY } }
  );
}

// Usa Claude pra extrair dados de texto ou imagem
async function extrairGasto(mensagem, imagemBase64 = null) {
  const prompt = `Você é um assistente que extrai informações de gastos.
Categorias possíveis: ${CATEGORIAS.join(", ")}.
Responda APENAS com JSON no formato: {"valor": 0.00, "categoria": "...", "descricao": "..."}
Se não conseguir identificar um gasto, responda: {"erro": "não identificado"}`;

  const content = [];
  if (imagemBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imagemBase64 } });
  }
  content.push({ type: "text", text: mensagem || "Extraia o gasto desta imagem." });

  const res = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 200,
    system: prompt,
    messages: [{ role: "user", content }],
  });

  try {
    return JSON.parse(res.content[0].text);
  } catch {
    return { erro: "não identificado" };
  }
}

// Webhook principal
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const evento = req.body;
    if (evento.event !== "messages.upsert") return;

    const msg = evento.data?.message;
    const groupId = evento.data?.key?.remoteJid;
    const fromMe = evento.data?.key?.fromMe;
    const pushName = evento.data?.pushName || "Alguém";

    if (fromMe) return;
    if (!groupId?.endsWith("@g.us")) return; // só grupos
    if (groupId !== process.env.GROUP_ID) return; // só o grupo certo

    let texto = msg?.conversation || msg?.extendedTextMessage?.text || "";
    let imagemBase64 = null;

    // Se for imagem, baixa e converte
    if (msg?.imageMessage) {
      // Evolution API: baixar mídia
      const mediaRes = await axios.post(
        `${process.env.EVOLUTION_URL}/chat/getBase64FromMediaMessage/${process.env.EVOLUTION_INSTANCE}`,
        { message: { key: evento.data.key, message: msg } },
        { headers: { apikey: process.env.EVOLUTION_API_KEY } }
      );
      imagemBase64 = mediaRes.data?.base64;
      texto = msg.imageMessage.caption || "";
    }

    // Comando /resumo
    if (texto.toLowerCase().includes("/resumo")) {
      const resumo = await montarResumo();
      await enviarMensagem(groupId, resumo);
      return;
    }

    // Tenta extrair gasto
    const gasto = await extrairGasto(texto, imagemBase64);
    if (gasto.erro) return;

    const hoje = new Date().toISOString().slice(0, 10);
    await salvarGasto(hoje, pushName, gasto.valor, gasto.categoria, gasto.descricao);

    const resumo = await montarResumo();
    const resposta = `✅ *Registrado!* ${gasto.categoria} - R$ ${gasto.valor.toFixed(2)} (${pushName})\n\n${resumo}`;
    await enviarMensagem(groupId, resposta);

  } catch (err) {
    console.error("Erro:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot rodando na porta ${PORT}`));
