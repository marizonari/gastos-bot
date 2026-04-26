const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "50mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const CATEGORIAS = [
  "Aluguel+Condomínio+IPTU+Seguro",
  "Diarista",
  "Internet",
  "Streaming",
  "Supercoffee",
  "TotalPass",
  "Zeca",
  "Energia",
  "Gás",
  "Supermercado",
  "Farmácia",
  "Viagens",
  "Presentes",
  "Restaurantes/Padaria",
  "Marmitas/LivUp",
  "Ifood",
  "Uber",
  "Outros"
];

const SHEET = process.env.SHEET_NAME || "Página1";

async function salvarGasto(data, quem, valor, categoria, descricao) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET}!A:E`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[data, quem, valor, categoria, descricao]] },
  });
}

async function buscarGastosMes() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET}!A:E`,
  });
  const rows = res.data.values || [];
  const mesAtual = new Date().toISOString().slice(0, 7);
  return rows.filter(r => r[0] && r[0].startsWith(mesAtual));
}

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
    "Aluguel+Condomínio+IPTU+Seguro": "🏠",
    "Diarista": "🧹",
    "Internet": "📡",
    "Streaming": "📺",
    "Supercoffee": "☕",
    "TotalPass": "🏋️",
    "Zeca": "🐶",
    "Energia": "⚡",
    "Gás": "🔥",
    "Supermercado": "🛒",
    "Farmácia": "💊",
    "Viagens": "✈️",
    "Presentes": "🎁",
    "Restaurantes/Padaria": "🍽️",
    "Marmitas/LivUp": "🥗",
    "Ifood": "🛵",
    "Uber": "🚗",
    "Outros": "📦"
  };

  let msg = `📊 *Resumo do mês:*\n`;
  for (const [quem, val] of Object.entries(totais)) msg += `${quem}: R$ ${val.toFixed(2)}\n`;
  msg += `─────────────────\n*Total: R$ ${total.toFixed(2)}*\n\n🏷️ *Por categoria:*\n`;
  for (const [cat, val] of Object.entries(categorias)) msg += `${emojiCat[cat] || "📦"} ${cat}: R$ ${val.toFixed(2)}\n`;
  return msg;
}

async function enviarMensagem(groupId, texto) {
  const url = `${process.env.EVOLUTION_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`;
  await axios.post(url, { number: groupId, text: texto }, {
    headers: { apikey: process.env.EVOLUTION_API_KEY, "Content-Type": "application/json" }
  });
}

async function extrairGasto(mensagem, imagemBase64 = null) {
  const prompt = `Você é um assistente que extrai informações de gastos domésticos de um casal. Categorias possíveis: ${CATEGORIAS.join(", ")}. Responda APENAS com JSON no formato: {"valor": 0.00, "categoria": "...", "descricao": "..."}. Use exatamente o nome da categoria como listado. Se não conseguir identificar um gasto, responda: {"erro": "não identificado"}`;
  const content = [];
  if (imagemBase64) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imagemBase64 } });
  content.push({ type: "text", text: mensagem || "Extraia o gasto desta imagem." });

  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: prompt,
    messages: [{ role: "user", content }],
  });

  const rawText = res.content[0].text;
  console.log("Resposta Claude raw:", rawText);

  try {
    const clean = rawText.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    console.log("Erro ao parsear JSON:", rawText);
    return { erro: "não identificado" };
  }
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const evento = req.body;
    console.log("Webhook recebido:", JSON.stringify(evento).slice(0, 300));

    if (evento.event !== "messages.upsert") return;

    const msg = evento.data?.message;
    const groupId = evento.data?.key?.remoteJid;
    const pushName = evento.data?.pushName || "Alguém";

    if (!groupId?.endsWith("@g.us")) return;
    if (groupId !== process.env.GROUP_ID) {
      console.log("Grupo ignorado:", groupId, "esperado:", process.env.GROUP_ID);
      return;
    }

    let texto = msg?.conversation || msg?.extendedTextMessage?.text || "";
    let imagemBase64 = null;

    if (msg?.imageMessage) {
      try {
        const mediaRes = await axios.post(
          `${process.env.EVOLUTION_URL}/chat/getBase64FromMediaMessage/${process.env.EVOLUTION_INSTANCE}`,
          { message: { key: evento.data.key, message: msg } },
          { headers: { apikey: process.env.EVOLUTION_API_KEY } }
        );
        imagemBase64 = mediaRes.data?.base64;
        texto = msg.imageMessage.caption || "";
      } catch (e) { console.log("Erro ao buscar imagem:", e.message); }
    }

    if (texto.toLowerCase().includes("/resumo")) {
      const resumo = await montarResumo();
      await enviarMensagem(groupId, resumo);
      return;
    }

    if (!texto && !imagemBase64) return;

    const gasto = await extrairGasto(texto, imagemBase64);
    console.log("Gasto extraído:", gasto);
    if (gasto.erro) return;

    const hoje = new Date().toISOString().slice(0, 10);
    await salvarGasto(hoje, pushName, gasto.valor, gasto.categoria, gasto.descricao);
    const resumo = await montarResumo();
    const resposta = `✅ *Registrado!* ${gasto.categoria} - R$ ${gasto.valor.toFixed(2)} (${pushName})\n\n${resumo}`;
    await enviarMensagem(groupId, resposta);

  } catch (err) {
    console.error("Erro:", err.message, err.stack);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot rodando na porta ${PORT}`));
