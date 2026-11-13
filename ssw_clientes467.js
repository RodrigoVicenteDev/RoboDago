// ssw_clientes467.js  (Robô de CADASTRO DE CLIENTES - opção 467 / ssw0176)
// Fluxo: login SSW -> unidade MTZ no menu (todas as unidades) -> opção 467 -> último movimento
//   010120 até hoje + tabela de fretes + formato Excel = S
//   -> roda 2x (Tabelas de fretes "C"=com, depois "S"=sem) -> cada execução: ► -> aviso
//   "Abrir a opção 156 agora" -> fila 156 -> espera "Baixar" -> baixa o .sswweb
//   -> só depois de baixar os DOIS sobe na API Dago (POST /api/clientes-ssw/importar, escopo com/sem)
// (baixar os dois antes de subir evita deixar o flag TemTabela pela metade se o SSW falhar no meio)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const { chromium } = require("playwright");
const { subirClientesSsw } = require("./dagoApi");
const { limparDownloads } = require("./limparDownloads");

// ================= LOG SETUP =================
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function nowLog() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const LOG_FILE = path.join(
  LOG_DIR,
  `robocliente467_${new Date().toISOString().slice(0, 10)}.log`
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

async function debugScreenshot(page, filename) {
  if (!DEBUG) return;
  const out = path.join(DEBUG_DIR, filename);
  await page.screenshot({ path: out, fullPage: true }).catch(() => {});
  console.log("📸 print salvo:", out);
}

function debugContextPages(context, label = "") {
  if (!DEBUG) return;
  console.log(`🧭 Páginas no context ${label}:`, context.pages().map((p) => p.url()));
}
// ===============================================

const LOGIN_URL = "https://tms.ssw.inf.br/bin/ssw0422";

// escopo -> valor do campo "Tabelas de fretes" (C-com, S-sem)
const ESCOPOS = [
  { escopo: "com", tabFrete: "C" },
  { escopo: "sem", tabFrete: "S" },
];

function ddMMyy(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

// "Hoje" no fuso do Brasil (o servidor roda em UTC) no formato ddMMyy do SSW.
function hojeBR() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("day")}${g("month")}${g("year")}`;
}

function parseBRDateTime(s) {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yy, HH, MM, SS] = m;
  return new Date(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS));
}

// Procura o seletor em TODOS os frames da página (o SSW é imprevisível quanto a frames).
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

// Captura janela nova por SELECTOR (robusto em headless), olhando todos os frames dela.
// `ignorar` = páginas que já existiam e não devem ser consideradas.
async function waitForNewPageWithSelector(context, selector, timeoutMs = 45000, ignorar = null) {
  const existing = ignorar ?? new Set(context.pages());
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (existing.has(p)) continue;

      await p.waitForLoadState("domcontentloaded").catch(() => {});
      for (const fr of p.frames()) {
        const count = await fr.locator(selector).count().catch(() => 0);
        if (count > 0) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Download que pode disparar na página que aciona OU numa aba nova que abre e fecha logo
// (comportamento do export do SSW) — o evento "download" é da PÁGINA, não do contexto.
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
    const onPage = (novaPagina) => novaPagina.on("download", onDownload);

    const timer = setTimeout(
      () => finalizar(reject, new Error(`Timeout de ${timeoutMs}ms esperando o download.`)),
      timeoutMs
    );

    for (const p of context.pages()) p.on("download", onDownload);
    paginaPrincipal.on("download", onDownload);
    context.on("page", onPage);

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
  if (v !== String(val)) throw new Error(`Campo ${sel} não aceitou o valor ${val} (ficou ${JSON.stringify(v)}).`);
}

// Digita a opção no menu (fill único + Tab — digitar char a char faz o menu abrir a opção
// no meio do caminho e duplica janelas).
async function typeOption(page, value) {
  const selector = 'input[name="f3"]';

  const menuFrame = await scopeWithSelector(page, selector, 30000);
  if (!menuFrame) {
    console.log("❌ Não achei input[name='f3'] em nenhum frame. Frames:");
    for (const f of page.frames()) console.log(" -", f.name(), f.url());
    throw new Error("Campo Opção (f3) não encontrado.");
  }

  const opcao = menuFrame.locator(selector).first();
  await opcao.waitFor({ state: "visible", timeout: 30000 });

  await opcao.scrollIntoViewIfNeeded().catch(() => {});
  await opcao.click({ force: true }).catch(() => {});
  await opcao.fill(value).catch(() => {});

  const v = await opcao.inputValue().catch(() => "");
  console.log("   Valor no campo Opção após preencher:", JSON.stringify(v));
  if (v !== value) {
    throw new Error(`Não consegui preencher ${value} no campo Opção (f3). Valor atual: ${JSON.stringify(v)}`);
  }

  await opcao.press("Tab").catch(() => {});
}

// Aviso do SSW ("Abrir a opção 156 agora"): achado pelo TEXTO do link, em qualquer frame.
// Se não aparecer, devolve o texto do painel de mensagem do SSW (#errormsg) como erro útil.
async function clickAbrir156ByText(page467, timeoutMs = 30000) {
  const sel = 'a:has-text("Abrir a opção 156")';
  const scope = await scopeWithSelector(page467, sel, timeoutMs);

  if (!scope) {
    let msg = "";
    for (const fr of page467.frames()) {
      const t = await fr.locator("#errormsg").innerText().catch(() => "");
      if (t && t.trim()) msg = t.trim();
    }
    await debugScreenshot(page467, "debug_cliente467_sem_aviso.png");
    throw new Error(`Aviso "Abrir a opção 156" não apareceu.${msg ? ` Mensagem do SSW: ${msg}` : ""}`);
  }

  const link = scope.locator(sel).first();
  await link.waitFor({ state: "visible", timeout: 30000 });
  console.log("   Link do aviso:", (await link.innerText()).trim());
  await link.click();
}

// Fila 156: atualiza até a linha da 467 (deste usuário, mais nova que `minSeq`) virar "Baixar".
// `minSeq` impede pegar a linha da execução anterior (ex.: a do escopo "com" ao esperar o "sem").
async function waitAndDownloadFrom156(context, page156, { startTimeMs, usuarioEsperado, minSeq = 0, timeoutMs = 240000, refreshEveryMs = 2000 }) {
  const atualizarSel = 'a:has-text("Atualizar")';
  const scope = await scopeWithSelector(page156, atualizarSel, 30000);
  if (!scope) throw new Error("Link 'Atualizar' da fila 156 não encontrado.");
  const atualizar = scope.locator(atualizarSel).first();

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await atualizar.click().catch(() => {});
    await page156.waitForTimeout(500);

    const rows = scope.locator("table tr");
    const rowCount = await rows.count();
    const candidatos = [];

    for (let i = 1; i < rowCount; i++) {
      const r = rows.nth(i);
      const cells = r.locator("td");
      if ((await cells.count()) < 7) continue;

      const seq = Number((await cells.nth(0).innerText()).trim());
      const opcaoTxt = (await cells.nth(1).innerText()).trim();
      if (!opcaoTxt.includes("467")) continue;
      if (!Number.isFinite(seq) || seq <= minSeq) continue;

      const dtTxt = (await cells.nth(2).innerText()).trim();
      const dt = parseBRDateTime(dtTxt);
      if (!dt) continue;
      if (dt.getTime() < startTimeMs - 2 * 60 * 1000) continue;

      const userTxt = (await cells.nth(3).innerText()).trim().toLowerCase();
      if (usuarioEsperado && userTxt !== usuarioEsperado.toLowerCase()) continue;

      candidatos.push({ seq, dt: dt.getTime(), dtTxt, userTxt, opcaoTxt, baixar: r.locator('a:has-text("Baixar")') });
    }

    candidatos.sort((a, b) => b.seq - a.seq);

    const alvo = candidatos[0];
    if (alvo && (await alvo.baixar.count())) {
      const download = await capturarDownload(context, page156, 120000, async () => {
        await alvo.baixar.first().click();
      });

      let suggested = (download.suggestedFilename() || "").trim();
      if (!suggested || !/\.(sswweb|csv|xls|xlsx|txt)$/i.test(suggested)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        suggested = `clientes467_${stamp}.sswweb`;
      }

      const outDir = path.join(process.cwd(), "downloads");
      fs.mkdirSync(outDir, { recursive: true });

      const outPath = path.join(outDir, suggested);
      await download.saveAs(outPath);

      return { ok: true, file: outPath, alvo };
    }

    await page156.waitForTimeout(refreshEveryMs);
  }

  return { ok: false, motivo: "timeout esperando link Baixar da 467 na fila 156" };
}

// A fonte certa é a opção "Excel" (CSV `;` com header na coluna CNPJ). Se vier o relatório
// em texto (ssw0176 largura-fixa), o backend recusa — melhor falhar aqui, com mensagem clara.
function validarArquivoExcel(file) {
  const stat = fs.statSync(file);
  if (stat.size < 500) throw new Error(`Arquivo baixado muito pequeno (${stat.size} bytes): ${file}`);

  const head = fs.readFileSync(file, "latin1").split(/\r?\n/).slice(0, 10).join("\n");
  if (!/CNPJ/i.test(head) || !head.includes(";")) {
    throw new Error(`Arquivo não parece o Excel da 467 (sem cabeçalho CNPJ com ';'): ${file}. Formato Excel = S foi aplicado?`);
  }
}

// Uma execução completa da 467 (preencher -> ► -> aviso -> 156 -> baixar) para um escopo.
async function gerarEBaixar(context, menuPage, { escopo, tabFrete }, { usuario, minSeq }) {
  console.log(`\n=== 467 [${escopo}] (Tabelas de fretes = ${tabFrete}) ===`);

  const existentes = new Set(context.pages());
  const p467Promise = waitForNewPageWithSelector(context, "#tab_frete", 45000, existentes);

  console.log('5) Digitando 467 no campo "Opção"...');
  await typeOption(menuPage, "467");

  debugContextPages(context, "(após digitar 467)");
  const p467 = await p467Promise;
  if (!p467) {
    debugContextPages(context, "(falha capturar 467)");
    throw new Error("O popup da opção 467 não abriu (não apareceu a página com #tab_frete).");
  }
  console.log("6) 467 abriu:", p467.url());
  await debugScreenshot(p467, `debug_cliente467_${escopo}_aberta.png`);

  console.log("7) Preenchendo filtros...");
  await fill(p467, "#data_ult_ini", "010120");
  await fill(p467, "#data_ult_fin", hojeBR());
  await fill(p467, "#tab_frete", tabFrete);
  await fill(p467, "#excel", "S");
  await debugScreenshot(p467, `debug_cliente467_${escopo}_filtros.png`);

  console.log("8) Clicando ► (gerar)...");
  const startDisparoMs = Date.now();
  const antes156 = new Set(context.pages());
  const p156Promise = waitForNewPageWithSelector(context, 'a:has-text("Atualizar")', 45000, antes156);

  const geraSel = 'a[onclick*="\'GER\'"], a[id="4"]';
  const geraScope = await scopeWithSelector(p467, geraSel, 30000);
  if (!geraScope) throw new Error("Não achei o botão ► (gerar) da 467.");
  const gera = geraScope.locator(geraSel).first();
  await gera.waitFor({ state: "visible", timeout: 30000 });
  await gera.click();

  console.log('9) No aviso, clicando "Abrir a opção 156"...');
  await clickAbrir156ByText(p467);

  const p156 = await p156Promise;
  if (!p156) throw new Error("Não consegui capturar a janela da opção 156 (não achei o link 'Atualizar').");
  console.log("10) 156 abriu. URL:", p156.url());
  await debugScreenshot(p156, `debug_cliente467_${escopo}_156.png`);

  console.log("11) Esperando a fila virar 'Baixar' e baixando...");
  const res = await waitAndDownloadFrom156(context, p156, {
    startTimeMs: startDisparoMs,
    usuarioEsperado: usuario,
    minSeq,
  });
  if (!res.ok) throw new Error(res.motivo);

  // renomeia com o escopo no nome (o nome do SSW é só CSVDAG...)
  const destino = path.join(path.dirname(res.file), `467_${escopo}_${path.basename(res.file)}`);
  fs.renameSync(res.file, destino);

  console.log("✅ Baixado:", destino);
  console.log("   Linha:", { seq: res.alvo.seq, dataHora: res.alvo.dtTxt, usuario: res.alvo.userTxt, opcao: res.alvo.opcaoTxt });

  validarArquivoExcel(destino);

  // fecha as janelas desta rodada (a do menu continua para a próxima)
  await p156.close().catch(() => {});
  await p467.close().catch(() => {});

  return { arquivo: destino, seq: res.alvo.seq };
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
    await debugScreenshot(page, "debug_cliente467_pos_login.png");

    // Unidade MTZ só no menu inicial: com ela o relatório 467 sai com TODAS as unidades
    // (a sigla da unidade dentro da 467 continua em branco).
    console.log("4.1) Trocando a unidade do menu para MTZ...");
    const unidadeScope = await scopeWithSelector(page, 'input[name="f2"]', 30000);
    if (!unidadeScope) throw new Error("Campo Unidade (f2) do menu não encontrado.");
    const unidade = unidadeScope.locator('input[name="f2"]').first();
    await unidade.click({ clickCount: 3 });
    await unidade.fill("MTZ");
    await unidade.press("Tab");
    await page.waitForTimeout(1500);
    const unidadeVal = await unidade.inputValue().catch(() => "");
    console.log("   Unidade no menu:", JSON.stringify(unidadeVal));
    if (unidadeVal.toUpperCase() !== "MTZ") throw new Error(`Não consegui trocar a unidade para MTZ (ficou ${JSON.stringify(unidadeVal)}).`);

    // 1) baixa os DOIS arquivos (com e sem) na mesma sessão
    const baixados = [];
    let minSeq = 0;
    for (const esc of ESCOPOS) {
      const r = await gerarEBaixar(context, page, esc, { usuario: USER, minSeq });
      baixados.push({ escopo: esc.escopo, arquivo: r.arquivo });
      minSeq = r.seq; // o próximo escopo só aceita linha da fila mais nova que esta
    }

    await browser.close().catch(() => {});

    // 2) só com os dois em mãos sobe na API (com e sem se complementam: COM ∪ SEM = cadastro todo)
    for (const b of baixados) {
      console.log(`12) Enviando escopo "${b.escopo}" para a API Dago...`);
      await subirClientesSsw(b.arquivo, b.escopo);
    }
    console.log("13) Importação do cadastro de clientes (467) concluída.");
  } catch (e) {
    console.error("❌ Falhou:", e);
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ✅ RETRY: tentar a cada 5 min, até concluir, por 3 vezes
const MAX_TENTATIVAS = 3;
const INTERVALO_MS = 5 * 60 * 1000;

(async () => {
  limparDownloads(7, "467_"); // só o lixo deste robô

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
