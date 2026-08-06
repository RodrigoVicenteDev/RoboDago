// ssw_coleta.js  (Robô de COLETAS - opção 103 / ssw0166)
// Fluxo: login SSW -> opção 103 -> Coletas normais: período de 1 mês até hoje,
// Mostrar em "e" (excel) -> clica na setinha (id=20) -> baixa .sswweb -> sobe na API Dago
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const { chromium } = require("playwright");
const { subirCsvColeta } = require("./dagoApi");
const { limparDownloads } = require("./limparDownloads");

// ================= LOG SETUP =================
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function nowLog() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const LOG_FILE = path.join(
  LOG_DIR,
  `robocoleta_${new Date().toISOString().slice(0, 10)}.log`
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

// Retorna o frame (ou main frame) da página que contém o seletor.
async function scopeWithSelector(page, selector, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const fr of page.frames()) {
      try {
        if ((await fr.locator(selector).count()) > 0) return fr;
      } catch {}
    }
    await page.waitForTimeout(200);
  }
  return null;
}

// Captura um download que pode disparar na página que aciona o gatilho OU numa aba nova
// que abre e fecha em seguida (comportamento do export excel do SSW).
// No Playwright o evento "download" é da PÁGINA, não do contexto — por isso anexamos o
// listener à página principal e a cada nova página aberta no contexto.
function capturarDownload(context, paginaPrincipal, timeoutMs, acionar) {
  return new Promise((resolve, reject) => {
    let terminado = false;

    const finalizar = (fn, arg) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      context.off("page", onPage);
      for (const p of context.pages()) p.off("download", onDownload);
      fn(arg);
    };

    const onDownload = (download) => finalizar(resolve, download);

    const onPage = (novaPagina) => {
      // a aba nova pode fechar rápido; ignoramos qualquer erro dela
      novaPagina.on("download", onDownload);
    };

    const timer = setTimeout(
      () => finalizar(reject, new Error(`Timeout de ${timeoutMs}ms esperando o download.`)),
      timeoutMs
    );

    // escuta nas páginas já abertas + na principal
    for (const p of context.pages()) p.on("download", onDownload);
    paginaPrincipal.on("download", onDownload);
    context.on("page", onPage);

    // dispara o gatilho depois que os listeners já estão ativos
    Promise.resolve()
      .then(acionar)
      .catch((e) => finalizar(reject, e));
  });
}

async function fill(page, sel, val) {
  const scope = await scopeWithSelector(page, sel, 30000);
  if (!scope) throw new Error(`Campo não encontrado em nenhum frame: ${sel}`);
  const loc = scope.locator(sel).first();
  await loc.waitFor({ state: "visible", timeout: 30000 });
  await loc.click({ clickCount: 3 });
  await loc.fill(String(val));
  const v = await loc.inputValue().catch(() => "");
  console.log(`   ✍️  ${sel} =`, JSON.stringify(v));
}

// ✅ Captura janela nova por SELECTOR (robusto em headless)
async function waitForNewPageWithSelector(context, selector, timeoutMs = 45000) {
  const existing = new Set(context.pages());
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (existing.has(p)) continue;

      await p.waitForLoadState("domcontentloaded").catch(() => {});
      // procura em todos os frames da nova página (não só o principal)
      for (const fr of p.frames()) {
        const count = await fr.locator(selector).count().catch(() => 0);
        if (count > 0) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// ✅ digitar a opção no menu (mesma técnica robusta do robô de CTRC)
async function typeOption(page, value) {
  const selector = 'input[name="f3"]';

  const menuFrame = await waitForFrameWithSelector(page, selector, 30000);
  if (!menuFrame) {
    console.log("❌ Não achei input[name='f3'] em nenhum frame. Frames:");
    for (const f of page.frames()) console.log(" -", f.name(), f.url());
    throw new Error("Campo Opção (f3) não encontrado.");
  }

  if (DEBUG) {
    const html = await menuFrame.content().catch(() => "");
    debugWriteFile("debug_frame_menu_coleta.html", html, "utf8");
  }

  const opcao = menuFrame.locator(selector).first();
  await opcao.waitFor({ state: "visible", timeout: 30000 });

  // 1) Preenche o valor de uma vez (sem digitar caractere a caractere).
  // O menu do SSW auto-abre a opção quando o código digitado fica válido; digitar
  // "1"→"10"→"103" fazia ele abrir no meio do caminho e depois de novo no gatilho,
  // resultando em janelas duplicadas. fill() seta o valor sem keyups intermediários.
  await opcao.scrollIntoViewIfNeeded().catch(() => {});
  await opcao.click({ force: true }).catch(() => {});
  await opcao.fill(value).catch(() => {});

  const v = await opcao.inputValue().catch(() => "");
  console.log("6) Valor no campo Opção após preencher:", JSON.stringify(v));

  if (v !== value) {
    throw new Error(`Não consegui preencher ${value} no campo Opção (f3). Valor atual: ${JSON.stringify(v)}`);
  }

  // 2) Dispara a navegação UMA ÚNICA vez (change + blur nativos via Tab).
  await opcao.press("Tab").catch(() => {});
}

async function runOnce() {
  const DOMINIO = process.env.SITE_DOMINIO ?? "";
  const CPF = process.env.SITE_CPF ?? "";
  const USER = process.env.SITE_USER ?? "";
  const PASS = process.env.SITE_PASS ?? "";

  if (!DOMINIO || !CPF || !USER || !PASS) {
    throw new Error("Variáveis SITE_DOMINIO/SITE_CPF/SITE_USER/SITE_PASS não carregadas. Confira o .env na pasta do robô.");
  }

  const HEADLESS = String(process.env.HEADLESS ?? "1").trim() === "1";
  const SLOWMO = Number(process.env.SLOWMO ?? (HEADLESS ? 0 : 800));
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });

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

    debugFrames(page, "(após login)");
    debugContextPages(context, "(após login)");
    await debugScreenshot(page, "debug_coleta_pos_login.png");

    console.log('5) Digitando 103 no campo "Opção"...');

    // 103 abre popup ssw0166: capturar nova page com o campo de período (input id=14)
    const p103Promise = waitForNewPageWithSelector(context, 'input[id="14"]', 45000);

    await typeOption(page, "103");

    debugFrames(page, "(após digitar 103)");
    debugContextPages(context, "(após digitar 103)");
    await debugScreenshot(page, "debug_coleta_pos_103.png");

    const p103 = await p103Promise;
    if (!p103) {
      debugContextPages(context, "(falha capturar 103)");
      throw new Error("O popup da opção 103 não abriu (não apareceu a página com input[id='14']).");
    }

    console.log("8) 103 abriu:", p103.url());
    await debugScreenshot(p103, "debug_coleta_janela_103.png");

    console.log("9) Preenchendo filtros (Coletas normais)...");
    const hoje = new Date();
    const d1mes = new Date(hoje);
    d1mes.setMonth(d1mes.getMonth() - 1);
    const inicio = ddMMyy(d1mes);
    const fim = ddMMyy(hoje);

    // Período de pesquisa: um mês atrás até hoje
    await fill(p103, 'input[id="14"]', inicio);
    await fill(p103, 'input[id="15"]', fim);

    // Mostrar em: e (excel)
    await fill(p103, 'input[id="17"]', "e");

    await debugScreenshot(p103, "debug_coleta_filtros.png");

    console.log('10) Clicando na setinha (id=20) para gerar o excel...');
    // O export excel do SSW costuma abrir uma aba nova só para servir o arquivo e
    // fechá-la em seguida. Escutamos o evento "download" tanto no contexto quanto em
    // cada página nova, resolvendo no primeiro que chegar — sem quebrar quando a aba fecha.
    const download = await capturarDownload(context, p103, 240000, async () => {
      const setaScope = await scopeWithSelector(p103, 'a[id="20"]', 30000);
      if (!setaScope) throw new Error("Não encontrei a setinha (a[id='20']) em nenhum frame da janela 103.");
      const seta = setaScope.locator('a[id="20"]').first();
      await seta.waitFor({ state: "visible", timeout: 30000 });
      await seta.click();
    });

    console.log("11) Download capturado.");

    let suggested = (download.suggestedFilename() || "").trim();
    console.log("11.1) Nome sugerido pelo download:", JSON.stringify(suggested));

    // Alguns downloads do SSW vêm sem nome (só GUID/vazio). Nesse caso geramos um.
    if (!suggested || !/\.(sswweb|csv|xls|xlsx|txt)$/i.test(suggested)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      suggested = `coleta_ssw0166_${stamp}.sswweb`;
    }

    const outDir = path.join(process.cwd(), "downloads");
    fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, suggested);
    await download.saveAs(outPath);

    console.log("✅ Baixado:", outPath);

    // O parser do backend lê o .sswweb cru (latin1, multi-layout) — sem pós-processamento
    console.log("12) Enviando arquivo para API Dago (importação de coletas)...");
    const up = await subirCsvColeta(outPath);
    console.log("13) Upload finalizado. Token:", up.importToken);

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
  limparDownloads(30); // apaga downloads com mais de 30 dias

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
