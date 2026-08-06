// limparDownloads.js
// Remove da pasta downloads/ os arquivos com mais de N dias (padrão 30).
// Usado por todos os robôs (GRU, CTB, REC, Coleta) na inicialização.
const fs = require("fs");
const path = require("path");

function limparDownloads(diasMax = 30) {
  const dir = path.join(process.cwd(), "downloads");
  if (!fs.existsSync(dir)) return;

  const limiteMs = diasMax * 24 * 60 * 60 * 1000;
  const agora = Date.now();
  let removidos = 0;

  for (const nome of fs.readdirSync(dir)) {
    const alvo = path.join(dir, nome);
    try {
      const st = fs.statSync(alvo);
      if (!st.isFile()) continue; // só arquivos; ignora subpastas
      if (agora - st.mtimeMs > limiteMs) {
        fs.unlinkSync(alvo);
        removidos++;
      }
    } catch (e) {
      console.warn(`⚠️ Falha ao limpar ${nome}:`, e.message);
    }
  }

  if (removidos > 0) {
    console.log(`🧹 Limpeza: ${removidos} arquivo(s) com mais de ${diasMax} dias removido(s) de downloads/.`);
  }
}

module.exports = { limparDownloads };
