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

  const tota
