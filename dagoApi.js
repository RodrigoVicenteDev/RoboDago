// dagoApi.js
// Pipeline Dago: login -> preview -> confirmar
// Logs: tudo via console.* (vai pro seu log porque você já intercepta)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");

const BASE_URL = process.env.DAGO_API_BASE ?? "https://api.paineldg.com.br";

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && typeof obj === "object" && obj[k]) return obj[k];
  }
  return null;
}

async function readJsonSafe(res) {
  const txt = await res.text().catch(() => "");
  try {
    return { json: JSON.parse(txt), txt };
  } catch {
    return { json: null, txt };
  }
}

function summarizeBody(txt, max = 1500) {
  if (!txt) return "";
  const s = String(txt);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// -------------------- LOGIN --------------------
async function dagoLogin(email, senha) {
  console.log("16.1) Autenticando na API Dago...");

  const url = `${BASE_URL}/api/Auth/login`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, senha }),
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(
      `❌ 16.1) Login falhou (${res.status}). Resposta:`,
      summarizeBody(txt) || res.statusText
    );
    throw new Error(`Login API Dago falhou (${res.status})`);
  }

  const token =
    pick(json, ["token", "accessToken", "access_token"]) ||
    pick(json?.data, ["token", "accessToken", "access_token"]) ||
    pick(json?.result, ["token", "accessToken", "access_token"]);

  if (!token) {
    console.error("❌ 16.1) Login OK, mas token não encontrado. JSON:", json);
    throw new Error("Login OK, mas token não encontrado");
  }

  console.log("16.2) Login OK na API Dago");
  return token;
}

// -------------------- PREVIEW --------------------
async function ctrcPreview(authToken, csvPath, praca = "GRU") {
  console.log("16.3) Enviando CSV para preview...");

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV não encontrado: ${csvPath}`);
  }

  const url = `${BASE_URL}/api/importacoes/ctrc/preview`;

  const form = new FormData();
  const buffer = fs.readFileSync(csvPath);
  const blob = new Blob([buffer], { type: "text/csv" });

  // Campos conforme você descreveu:
  // - arquivo (multipart)
  // - string praca (ex: GRU)
  const filename = path.basename(csvPath);
  form.append("Arquivo", blob, filename);
  form.append("Praca", praca);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      // Não setar Content-Type manualmente no multipart
    },
    body: form,
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(
      `❌ 16.3) Preview falhou (${res.status}). Resposta:`,
      summarizeBody(txt) || res.statusText
    );
    throw new Error(`Preview falhou (${res.status})`);
  }

  // Token da importação (o que você disse que a segunda API usa no confirmar)
  const importToken =
    pick(json, ["token", "importToken"]) ||
    pick(json?.data, ["token", "importToken"]) ||
    pick(json?.result, ["token", "importToken"]);

  if (!importToken) {
    console.error("❌ 16.3) Preview OK, mas token não encontrado. JSON:", json);
    throw new Error("Preview OK, mas token de importação não retornado");
  }

  console.log("16.4) Preview OK. Token da importação:", importToken);
  return { importToken, previewResponse: json };
}

// -------------------- CONFIRMAR --------------------
// Dica: confirmação pode levar ~5 minutos. Vamos:
// - manter timeout alto (default 20min)
// - heartbeat no log a cada 30s
async function ctrcConfirmar(authToken, importToken) {
  console.log("16.5) Confirmando importação (pode levar ~5 min)...");

  const url = `${BASE_URL}/api/importacoes/ctrc/confirmar/${encodeURIComponent(importToken)}`;

  const controller = new AbortController();
  const timeoutMs = Number(process.env.DAGO_CONFIRM_TIMEOUT_MS ?? 20 * 60 * 1000);
  const heartbeatMs = Number(process.env.DAGO_HEARTBEAT_MS ?? 30 * 1000);

  const t = setTimeout(() => controller.abort(), timeoutMs);
  const h = setInterval(() => {
    console.log("16.5) ...ainda aguardando confirmação da API...");
  }, heartbeatMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    const { json, txt } = await readJsonSafe(res);

    if (!res.ok) {
      console.error(
        `❌ 16.5) Confirmar falhou (${res.status}). Resposta:`,
        summarizeBody(txt) || res.statusText
      );
      throw new Error(`Confirmar falhou (${res.status})`);
    }

    console.log("16.6) Confirmação concluída");
    return json ?? { raw: txt };
  } catch (e) {
    if (e?.name === "AbortError") {
      console.error(`❌ 16.5) Timeout na confirmação após ${timeoutMs}ms`);
      throw new Error(`Timeout na confirmação (${timeoutMs}ms)`);
    }
    console.error("❌ 16.5) Erro na confirmação:", e?.message || e);
    throw e;
  } finally {
    clearTimeout(t);
    clearInterval(h);
  }
}

// -------------------- PIPELINE COMPLETO --------------------
async function subirCsvCtrc(csvPath, praca = "GRU") {
  console.log("16) Iniciando upload na API Dago...");

  const email = process.env.DAGO_EMAIL ?? "";
  const senha = process.env.DAGO_SENHA ?? "";

  if (!email || !senha) {
    throw new Error("Defina DAGO_EMAIL e DAGO_SENHA nas variáveis de ambiente.");
  }

  const authToken = await dagoLogin(email, senha);

  const { importToken, previewResponse } = await ctrcPreview(authToken, csvPath, praca);

  const confirmResponse = await ctrcConfirmar(authToken, importToken);

  // Formato esperado pelo seu controller:
  // {
  //   sucesso: true,
  //   inseridos,
  //   totalErros,
  //   erros: [{ linha, erro, severidade }]
  // }
  const inseridos = confirmResponse?.inseridos ?? 0;
  const totalErros = confirmResponse?.totalErros ?? 0;
  const sucesso = confirmResponse?.sucesso;

  console.log("16.7) Resultado da importação:");
  console.log("   ➤ sucesso:", sucesso);
  console.log("   ➤ inseridos:", inseridos);
  console.log("   ➤ totalErros:", totalErros);

  if (Array.isArray(confirmResponse?.erros) && confirmResponse.erros.length > 0) {
    console.error("❌ 16.8) Erros retornados pela API (linha a linha):");
    for (const e of confirmResponse.erros) {
      console.error(
        `   ➤ Linha ${e.linha} | Severidade: ${e.severidade} | Erro: ${e.erro}`
      );
    }
  } else {
    console.log("16.8) Nenhum erro retornado pela API.");
  }

  return {
    authToken,          // útil se você quiser reaproveitar
    importToken,
    previewResponse,
    confirmResponse,
  };
}

// ==================== COLETAS (relatório 166 / opção 103) ====================

// -------------------- PREVIEW COLETA --------------------
async function coletaPreview(authToken, csvPath) {
  console.log("16.3) Enviando arquivo de coletas para preview...");

  if (!fs.existsSync(csvPath)) {
    throw new Error(`Arquivo não encontrado: ${csvPath}`);
  }

  const url = `${BASE_URL}/api/coletas/importacao/preview`;

  const form = new FormData();
  const buffer = fs.readFileSync(csvPath);
  const blob = new Blob([buffer], { type: "text/csv" });

  const filename = path.basename(csvPath);
  form.append("Arquivo", blob, filename);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      // Não setar Content-Type manualmente no multipart
    },
    body: form,
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(
      `❌ 16.3) Preview de coletas falhou (${res.status}). Resposta:`,
      summarizeBody(txt) || res.statusText
    );
    throw new Error(`Preview de coletas falhou (${res.status})`);
  }

  const importToken =
    pick(json, ["token", "importToken"]) ||
    pick(json?.data, ["token", "importToken"]) ||
    pick(json?.result, ["token", "importToken"]);

  if (!importToken) {
    console.error("❌ 16.3) Preview OK, mas token não encontrado. JSON:", json);
    throw new Error("Preview de coletas OK, mas token de importação não retornado");
  }

  console.log("16.4) Preview OK. Token:", importToken);
  console.log("   ➤ totalLinhas:", json?.totalLinhas ?? "?");
  console.log("   ➤ novas:", json?.novas ?? "?");
  console.log("   ➤ atualizadas:", json?.atualizadas ?? "?");

  return { importToken, previewResponse: json };
}

// -------------------- CONFIRMAR COLETA --------------------
async function coletaConfirmar(authToken, importToken) {
  console.log("16.5) Confirmando importação de coletas...");

  const url = `${BASE_URL}/api/coletas/importacao/confirmar/${encodeURIComponent(importToken)}`;

  const controller = new AbortController();
  const timeoutMs = Number(process.env.DAGO_CONFIRM_TIMEOUT_MS ?? 20 * 60 * 1000);
  const heartbeatMs = Number(process.env.DAGO_HEARTBEAT_MS ?? 30 * 1000);

  const t = setTimeout(() => controller.abort(), timeoutMs);
  const h = setInterval(() => {
    console.log("16.5) ...ainda aguardando confirmação da API...");
  }, heartbeatMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    const { json, txt } = await readJsonSafe(res);

    if (!res.ok) {
      console.error(
        `❌ 16.5) Confirmar coletas falhou (${res.status}). Resposta:`,
        summarizeBody(txt) || res.statusText
      );
      throw new Error(`Confirmar coletas falhou (${res.status})`);
    }

    console.log("16.6) Confirmação concluída");
    return json ?? { raw: txt };
  } catch (e) {
    if (e?.name === "AbortError") {
      console.error(`❌ 16.5) Timeout na confirmação após ${timeoutMs}ms`);
      throw new Error(`Timeout na confirmação (${timeoutMs}ms)`);
    }
    console.error("❌ 16.5) Erro na confirmação:", e?.message || e);
    throw e;
  } finally {
    clearTimeout(t);
    clearInterval(h);
  }
}

// -------------------- PIPELINE COLETA --------------------
async function subirCsvColeta(csvPath) {
  console.log("16) Iniciando upload de coletas na API Dago...");

  const email = process.env.DAGO_EMAIL ?? "";
  const senha = process.env.DAGO_SENHA ?? "";

  if (!email || !senha) {
    throw new Error("Defina DAGO_EMAIL e DAGO_SENHA nas variáveis de ambiente.");
  }

  const authToken = await dagoLogin(email, senha);

  const { importToken, previewResponse } = await coletaPreview(authToken, csvPath);

  const confirmResponse = await coletaConfirmar(authToken, importToken);

  // Formato do ColetaImportResultadoDTO:
  // { inseridas, atualizadas, ignoradas, designacoesCriadas, erros: [...], avisos: [...] }
  console.log("16.7) Resultado da importação de coletas:");
  console.log("   ➤ inseridas:", confirmResponse?.inseridas ?? 0);
  console.log("   ➤ atualizadas:", confirmResponse?.atualizadas ?? 0);
  console.log("   ➤ ignoradas:", confirmResponse?.ignoradas ?? 0);
  console.log("   ➤ designacoesCriadas:", confirmResponse?.designacoesCriadas ?? 0);

  if (Array.isArray(confirmResponse?.erros) && confirmResponse.erros.length > 0) {
    console.error("❌ 16.8) Erros retornados pela API (linha a linha):");
    for (const e of confirmResponse.erros) {
      console.error(`   ➤ Linha ${e.linha} | Erro: ${e.erro ?? e.mensagem ?? JSON.stringify(e)}`);
    }
  } else {
    console.log("16.8) Nenhum erro retornado pela API.");
  }

  if (Array.isArray(confirmResponse?.avisos) && confirmResponse.avisos.length > 0) {
    console.log("⚠️ 16.9) Avisos retornados pela API:");
    for (const a of confirmResponse.avisos) {
      console.log(`   ➤ Linha ${a.linha} | Aviso: ${a.erro ?? a.mensagem ?? JSON.stringify(a)}`);
    }
  }

  return {
    authToken,
    importToken,
    previewResponse,
    confirmResponse,
  };
}

module.exports = {
  subirCsvCtrc,
  dagoLogin,
  ctrcPreview,
  ctrcConfirmar,
  subirCsvColeta,
  coletaPreview,
  coletaConfirmar,
};
