// login.js / ssw.js  (HEADLESS TRUE + LOG + ENCODING FIX + DEBUG)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { subirCsvCtrc } = require("./dagoApi");
const { limparDownloads } = require("./limparDownloads");

// ================= LOG SETUP =================
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function nowLog() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const LOG_FILE = path.join(
  LOG_DIR,
  `robocsv_${new Date().toISOString().slice(0, 10)}.log`
);

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function writeLog(level, args) {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  logStream.write(`[${nowLog()}] [${level}] ${msg}\n`);
}

const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  writeLog("INFO", args);
  originalLog(...args);
};

console.error = (...args) => {
  writeLog("ERROR", args);
  originalError(...args);
};

process.on("uncaughtException", (err) => {
  writeLog("FATAL", [err?.stack || err]);
  originalError(err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  writeLog("FATAL", [err?.stack || err]);
  originalError(err);
  process.exit(1);
});
// ============================================

// ================= DEBUG SETUP =================
const DEBUG = String(process.env.DEBUG ?? "").trim() === "1";
const DEBUG_DIR = path.join(process.cwd(), "debug");
if (DEBUG && !fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

function debugPath(name) {
  return path.join(DEBUG_DIR, name);
}

async function debugScreenshot(page, filename) {
  if (!DEBUG) return;
  const out = debugPath(filename);
  await page.screenshot({ path: out, fullPage: true }).catch(() => {});
  console.log("📸 print salvo:", out);
}

function debugWriteFile(filename, content, encoding = "utf8") {
  if (!DEBUG) return;
  const out = debugPath(filename);
  fs.writeFileSync(out, content, encoding);
  console.log("🧾 arquivo salvo:", out);
}

function debugContextPages(context, label = "") {
  if (!DEBUG) return;
  const urls = context.pages().map((p) => p.url());
  console.log(`🧭 Páginas no context ${label}:`, urls);
}

function debugFrames(page, label = "") {
  if (!DEBUG) return;
  console.log(`🧩 Frames ${label}:`);
  for (const f of page.frames()) {
    console.log(" - name:", f.name(), "| url:", f.url());
  }
}
// ===============================================

const LOGIN_URL = "https://sistema.ssw.inf.br/bin/ssw0422";

function ddMMyy(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

function parseBRDateTime(s) {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [_, dd, mm, yy, HH, MM, SS] = m;
  const year = 2000 + Number(yy);
  return new Date(year, Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS));
}

async function findFrameWithSelector(page, selector) {
  for (const fr of page.frames()) {
    try {
      if ((await fr.locator(selector).count()) > 0) return fr;
    } catch {}
  }
  return null;
}

async function waitForFrameWithSelector(page, selector, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fr = await findFrameWithSelector(page, selector);
    if (fr) return fr;
    await page.waitForTimeout(250);
  }
  return null;
}

// ✅ .sswweb -> csv remove 1ª linha
// ✅ lê em latin1 para não virar <?> e limpa BOM/controles sem matar acentos
function removerZerosCamposSelecionados(csvText) {
  const SEP = ";";
  const linhas = csvText.split(/\r?\n/);
  if (linhas.length < 2) return csvText;

  const header = linhas[0].split(SEP).map((h) => h.trim().toLowerCase());

  const idxNF = header.findIndex((h) => h === "numero da nota fiscal");
  const idxCnpjRem = header.findIndex((h) => h === "cnpj remetente");
  const idxCnpjPag = header.findIndex((h) => h === "cnpj pagador");
  const idxNotasFiscais = header.findIndex((h) => h === "notas fiscais");

  const idxs = [idxNF, idxCnpjRem, idxCnpjPag, idxNotasFiscais].filter((i) => i >= 0);
  if (idxs.length === 0) return csvText;

  for (let i = 1; i < linhas.length; i++) {
    if (!linhas[i]) continue;

    const parts = linhas[i].split(SEP);

    for (const idx of idxs) {
      if (idx >= parts.length) continue;

      let v = String(parts[idx] ?? "")
        .replace(/\uFEFF/g, "")     // BOM
        .replace(/\uFFFD/g, "")     // �
        .replace(/\u00A0/g, " ")    // NBSP
        .replace(/Â/g, "")          // lixo comum
        .replace(/[\u0000-\u001F\u007F]/g, "") // controles
        .trim();

      // Numero da Nota + CNPJs → somente dígitos
      if (idx === idxNF || idx === idxCnpjRem || idx === idxCnpjPag) {
        v = v.replace(/[^\d]/g, "");
        v = v.replace(/^0+/, "");
        if (v === "") v = "0";
      }

      // Notas Fiscais → ficar só com o número depois do "/" (mantém lista separada por vírgula)
 if (idx === idxNotasFiscais) {
  v = v
    .replace(/\uFEFF/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/Â/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const itens = v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const normalizados = itens
    .map((item) => {
      const afterSlash = item.includes("/") ? item.split("/").pop() : item;

      let num = String(afterSlash ?? "").replace(/[^\d]/g, "");
      num = num.replace(/^0+/, "");

      if (num === "") return null; // não vira "0"
      return num;
    })
    .filter(Boolean);

  v = normalizados.join(", ");
}
      parts[idx] = v;
    }

    linhas[i] = parts.join(SEP);
  }

  return linhas.join("\n");
}




function processarSswwebParaCsv(inputPath) {
  console.log("14) Processando arquivo (remover 1ª linha):", inputPath);

  const content = fs.readFileSync(inputPath, "latin1");
  const lines = content.split(/\r?\n/);

  if (lines.length < 2) throw new Error("Arquivo inválido ou vazio");

  let finalContent = lines
    .slice(1)
    .join("\n")
    .replace(/\uFEFF/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  // ✅ NOVO: tira zeros à esquerda somente de NF e CNPJs (sem mexer nas chaves enormes)
  finalContent = removerZerosCamposSelecionados(finalContent);

  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);

  const outName =
    base.replace(/\.sswweb$/i, "").replace(/\.csv$/i, "") + "_processado.csv";

  const outputPath = path.join(dir, outName);
  fs.writeFileSync(outputPath, finalContent, "latin1");

  console.log("15) CSV processado gerado:", outputPath);
  return outputPath;
}


async function fill(page, sel, val) {
  const loc = page.locator(sel);
  await loc.waitFor({ state: "visible", timeout: 30000 });
  await loc.click({ clickCount: 3 });
  await loc.fill(String(val));
}

async function click(page, sel) {
  const loc = page.locator(sel);
  await loc.waitFor({ state: "visible", timeout: 30000 });
  await loc.click();
}

// ✅ Captura janela nova por SELECTOR (robusto em headless)
async function waitForNewPageWithSelector(context, selector, timeoutMs = 45000) {
  const existing = new Set(context.pages());
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (existing.has(p)) continue;

      await p.waitForLoadState("domcontentloaded").catch(() => {});
      const count = await p.locator(selector).count().catch(() => 0);
      if (count > 0) return p;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// ✅ digitar 455 robusto em headless (fallback fill + gatilho de blur/change)
async function typeOption455(page, value = "455", unidade = "VIX") {
  const unidadeSelector = 'input[name="f2"], input[id="2"]';
  const opcaoSelector = 'input[name="f3"]';

  const menuFrame = await waitForFrameWithSelector(page, opcaoSelector, 30000);
  if (!menuFrame) {
    console.log("❌ Não achei input[name='f3'] em nenhum frame. Frames:");
    for (const f of page.frames()) console.log(" -", f.name(), f.url());
    throw new Error("Campo Opção (f3) não encontrado.");
  }

  if (DEBUG) {
    const html = await menuFrame.content().catch(() => "");
    debugWriteFile("debug_frame_menu.html", html, "utf8");
  }

  // ✅ Trocar Unidade GRU -> VIX
  const unidadeLoc = menuFrame.locator(unidadeSelector).first();
  await unidadeLoc.waitFor({ state: "visible", timeout: 30000 });

  await unidadeLoc.scrollIntoViewIfNeeded().catch(() => {});
  await unidadeLoc.click({ force: true }).catch(() => {});
  await unidadeLoc.focus().catch(() => {});
  await unidadeLoc.press("Control+A").catch(() => {});
  await unidadeLoc.press("Backspace").catch(() => {});
  await unidadeLoc.type(unidade, { delay: 80 }).catch(() => {});

  let u = await unidadeLoc.inputValue().catch(() => "");
  if (u !== unidade) {
    await unidadeLoc.fill(unidade).catch(() => {});
    u = await unidadeLoc.inputValue().catch(() => "");
  }

  console.log("5.1) Valor no campo Unidade:", JSON.stringify(u));

  if (u !== unidade) {
    throw new Error(`Não consegui alterar a Unidade para ${unidade}. Valor atual: ${u}`);
  }

  // Importante: esse campo tem onchange="atualizaQuadroIndicadores(...)"
  await unidadeLoc.dispatchEvent("input").catch(() => {});
  await unidadeLoc.dispatchEvent("change").catch(() => {});
  await unidadeLoc.press("Tab").catch(() => {});
  await page.waitForTimeout(800);

  // ✅ Preencher Opção 455
  const opcao = menuFrame.locator(opcaoSelector).first();
  await opcao.waitFor({ state: "visible", timeout: 30000 });

  for (let attempt = 1; attempt <= 2; attempt++) {
    await opcao.scrollIntoViewIfNeeded().catch(() => {});
    await opcao.click({ force: true }).catch(() => {});
    await opcao.focus().catch(() => {});

    await opcao.press("Control+A").catch(() => {});
    await opcao.press("Backspace").catch(() => {});

    await opcao.type(value, { delay: 120 }).catch(() => {});

    let v = await opcao.inputValue().catch(() => "");
    if (v !== value) {
      await opcao.fill(value).catch(() => {});
      v = await opcao.inputValue().catch(() => "");
    }

    console.log(`6.${attempt}) Valor no campo Opção após digitar:`, JSON.stringify(v));

    if (v === value) {
      await opcao.dispatchEvent("input").catch(() => {});
      await opcao.dispatchEvent("change").catch(() => {});
      await opcao.press("Tab").catch(() => {});
      await opcao.blur().catch(() => {});
      return;
    }

    await page.waitForTimeout(400);
  }

  throw new Error(`Não consegui digitar ${value} no campo Opção (f3).`);
}

// ✅ clique do aviso: pelo TEXTO (não por id)
async function clickAbrir156ByText(page455) {
  await page455.locator("text=Aviso").waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  const link = page455.locator('a:has-text("Abrir a opção 156")').first();
  await link.waitFor({ state: "visible", timeout: 30000 });
  console.log("11.1) Link do aviso:", (await link.innerText()).trim());
  await link.click();
}

async function waitAndDownloadFrom156(page156, { startTimeMs, usuarioEsperado, timeoutMs = 240000, refreshEveryMs = 2000 }) {
  const atualizar = page156.locator('a:has-text("Atualizar")').first();
  await atualizar.waitFor({ state: "visible", timeout: 30000 });

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await atualizar.click();
    await page156.waitForTimeout(500);

    const rows = page156.locator("table tr");
    const rowCount = await rows.count();

    const candidatos = [];

    for (let i = 1; i < rowCount; i++) {
      const r = rows.nth(i);
      const cells = r.locator("td");
      const ccount = await cells.count();
      if (ccount < 7) continue;

      const opcaoTxt = (await cells.nth(1).innerText()).trim();
      if (!opcaoTxt.includes("455")) continue;

      const dtTxt = (await cells.nth(2).innerText()).trim();
      const dt = parseBRDateTime(dtTxt);
      if (!dt) continue;

      if (dt.getTime() < (startTimeMs - 2 * 60 * 1000)) continue;

      const userTxt = (await cells.nth(3).innerText()).trim().toLowerCase();
      const userOk = !usuarioEsperado || userTxt === usuarioEsperado.toLowerCase();

      const baixar = r.locator('a:has-text("Baixar")');

      candidatos.push({ dt: dt.getTime(), dtTxt, userTxt, userOk, opcaoTxt, baixar });
    }

    candidatos.sort((a, b) => {
      if (a.userOk !== b.userOk) return a.userOk ? -1 : 1;
      return b.dt - a.dt;
    });

    const alvo = candidatos[0];
    if (alvo && (await alvo.baixar.count())) {
      const downloadPromise = page156.waitForEvent("download");
      await alvo.baixar.first().click();
      const download = await downloadPromise;

      const suggested = download.suggestedFilename();
      const outDir = path.join(process.cwd(), "downloads");
      fs.mkdirSync(outDir, { recursive: true });

      const outPath = path.join(outDir, suggested);
      await download.saveAs(outPath);

      return { ok: true, file: outPath, alvo };
    }

    await page156.waitForTimeout(refreshEveryMs);
  }

  return { ok: false, motivo: "timeout esperando link Baixar na fila 156" };
}

async function runOnce() {
  const DOMINIO = process.env.SITE_DOMINIO ?? "";
  const CPF = process.env.SITE_CPF ?? "";
  const USER = process.env.SITE_USER ?? "";
  const PASS = process.env.SITE_PASS ?? "";

  const browser = await chromium.launch({ headless:true });

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1366, height: 768 },
    });

    const page = await context.newPage();

    console.log("1) Abrindo login...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    console.log("2) Preenchendo login...");
    await page.locator('input[id="1"]').fill(DOMINIO);
    await page.locator('input[id="2"]').fill(CPF);
    await page.locator('input[id="3"]').fill(USER);
    await page.locator('input[id="4"]').fill(PASS);

    console.log("3) Clicando entrar...");
    await page.locator('a[id="5"]').click();
    await page.waitForLoadState("networkidle");
    console.log("4) Logado. URL:", page.url());

    // DEBUG: print + frames + páginas
    debugFrames(page, "(após login)");
    debugContextPages(context, "(após login)");
    await debugScreenshot(page, "debug_pos_login.png");

    console.log('5) Digitando 455 no campo "Opção"...');
    const startDisparoMs = Date.now();

    // DEBUG: print antes do 455 (às vezes ajuda)
    await debugScreenshot(page, "debug_antes_455.png");

    // 455 abre popup: capturar nova page que contenha input[id=9]
    const p455Promise = waitForNewPageWithSelector(context, 'input[id="9"]', 45000);

   await typeOption455(page, "455", "VIX");

    // DEBUG: print e dump após digitar 455
    debugFrames(page, "(após digitar 455)");
    debugContextPages(context, "(após digitar 455)");
    await debugScreenshot(page, "debug_pos_455.png");

    const p455 = await p455Promise;
    if (!p455) {
      // DEBUG: último dump
      debugContextPages(context, "(falha capturar 455)");
      throw new Error("O popup da opção 455 não abriu (não apareceu a página com input[id='9']).");
    }

    console.log("8) 455 abriu:", p455.url());

    // DEBUG: print da janela 455 capturada
    await debugScreenshot(p455, "debug_janela_455.png");
    debugFrames(p455, "(janela 455)");

    console.log("9) Preenchendo filtros da 455...");
    const hoje = new Date();
    const d31 = new Date(hoje);
    d31.setDate(d31.getDate() - 31);
    const inicio = ddMMyy(d31);
    const fim = ddMMyy(hoje);

    await fill(p455, 'input[id="9"]', inicio);
    await fill(p455, 'input[id="10"]', fim);
    await fill(p455, 'input[id="11"]', inicio);
    await fill(p455, 'input[id="12"]', fim);

    await fill(p455, 'input[id="7"]', "58975476000390");

    await fill(p455, 'input[id="21"]', "T");
    await fill(p455, 'input[id="35"]', "E");
    await fill(p455, 'input[id="37"]', "B");
    await fill(p455, 'input[id="38"]', "F");

    console.log('10) Clicando botão id="40"...');
    await click(p455, 'a[id="40"], input[id="40"], button[id="40"]');

    console.log('11) No aviso, clicando "Abrir a opção 156"...');

    // 156 abre popup: capturar nova page que contenha link "Atualizar"
    const p156Promise = waitForNewPageWithSelector(context, 'a:has-text("Atualizar")', 45000);

    await clickAbrir156ByText(p455);

    const p156 = await p156Promise;
    if (!p156) throw new Error("Não consegui capturar o popup/janela da opção 156 (não achei o link 'Atualizar').");

    console.log("12) 156 abriu. URL:", p156.url());

    // DEBUG: print da janela 156
    await debugScreenshot(p156, "debug_janela_156.png");

    console.log("13) Esperando fila virar 'Baixar' e baixando...");
    const downloadRes = await waitAndDownloadFrom156(p156, {
      startTimeMs: startDisparoMs,
      usuarioEsperado: USER,
      timeoutMs: 240000,
      refreshEveryMs: 2000,
    });

    if (!downloadRes.ok) throw new Error(downloadRes.motivo);

    console.log("✅ Baixado:", downloadRes.file);
    console.log("   Linha:", {
      dataHora: downloadRes.alvo.dtTxt,
      usuario: downloadRes.alvo.userTxt,
      opcao: downloadRes.alvo.opcaoTxt,
    });

    const csvProcessado = processarSswwebParaCsv(downloadRes.file);
    console.log("✅ CSV final pronto:", csvProcessado);

   


   console.log("16) Enviando CSV para API Dago...");
   const up = await subirCsvCtrc(csvProcessado, "VIX");
   console.log("17) Upload finalizado. Token:", up.importToken);

    await browser.close();
  } catch (e) {
    console.error("❌ Falhou:", e);
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ✅ RETRY: tentar a cada 5 min, até concluir, por 3 vezes
const MAX_TENTATIVAS = 3;
const INTERVALO_MS = 5 * 60 * 1000; // 5 minutos

(async () => {
  limparDownloads(7); // apaga downloads com mais de 7 dias

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    console.log(`🔁 Tentativa ${tentativa}/${MAX_TENTATIVAS} iniciada...`);

    try {
      await runOnce();
      process.exit(0);
    } catch (err) {
      console.error(`❌ Erro na tentativa ${tentativa}:`, err?.stack || err);

      if (tentativa >= MAX_TENTATIVAS) {
        console.error("🛑 Limite de tentativas atingido. Abortando.");
        process.exit(1);
      }

      console.log("⏳ Aguardando 5 minutos antes da próxima tentativa...");
      await new Promise((r) => setTimeout(r, INTERVALO_MS));
    }
  }
})();
