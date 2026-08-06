// rodar_todos.js
const { spawn } = require("child_process");
const path = require("path");

const robos = [
  "ssw.js",      // GRU
  "ssw_ctb.js",  // CTB
  "ssw_rec.js",  // REC
];

function rodarRobo(arquivo) {
  return new Promise((resolve, reject) => {
    console.log(`\n🚀 Iniciando ${arquivo}...\n`);

    const processo = spawn("node", [path.join(__dirname, arquivo)], {
      stdio: "inherit",
      shell: true,
    });

    processo.on("close", (code) => {
      if (code === 0) {
        console.log(`\n✅ ${arquivo} finalizado com sucesso.\n`);
        resolve();
      } else {
        reject(new Error(`${arquivo} terminou com código ${code}`));
      }
    });
  });
}

(async () => {
  for (const robo of robos) {
    try {
      await rodarRobo(robo);
    } catch (err) {
      console.error(`❌ Erro no robô ${robo}:`, err.message);

      // Se quiser parar tudo ao dar erro, deixe assim:
      process.exit(1);

      // Se quiser continuar mesmo com erro, troque por:
      // continue;
    }
  }

  console.log("🎉 Todos os robôs finalizaram.");
})();