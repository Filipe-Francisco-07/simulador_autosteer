// Prova, ponta a ponta, que da para configurar o tradutor por fora do AgOpenGPS.
//
//   node config-tradutor/conferir.js              (firmware no PC)
//   node config-tradutor/conferir.js COM6         (placa de verdade)
//
// O AgIO precisa estar FECHADO para usar a porta: ele segura a serial do
// tradutor e porta serial no Windows e exclusiva.

const { Tradutor, conferir } = require('./tradutor.js');

// Perfil de exemplo do JD 5078, com os numeros que o chamado 15 lista.
const PERFIL = {
  nome: 'JD 5078',
  contagensPorGrau: 19,          // "pda" do chamado
  ackerman: 100,
  correnteDesligamento: 9,       // A
  estercoMaxEsquerdaGraus: 32.0,
  estercoMaxDireitaGraus: 34.0,
  velocidadeMinimaKmh: 1.5,
  ganhoP: 20,
  pwmAlto: 180,
  pwmBaixo: 30,
  pwmMinimo: 25,
  offsetDirecao: 0,
  set0: 56,                      // padrao de fabrica do AOG
  set1: 0,
};

const linha = (s) => console.log('  ' + s);

(async () => {
  const t = new Tradutor();
  const porta = process.argv[2];

  console.log('\n===== CONFIGURACAO DO TRADUTOR, FORA DO AgOpenGPS =====\n');
  try {
    if (porta) await t.abrirPorta(porta);
    else await t.abrirSimulado();
    linha('ligado em: ' + t.origem);
  } catch (e) {
    linha('NAO consegui ligar: ' + e.message);
    if (porta) linha('o AgIO esta aberto? ele segura essa porta.');
    process.exit(1);
  }

  try {
    // ---- 1. o modulo se apresenta ----
    console.log('\n1) O QUE O MODULO DIZ DE SI\n');
    const antes = await t.ler();
    linha(`CPD .......................... ${antes.contagensPorGrau}`);
    linha(`Ackerman ..................... ${antes.ackerman}`);
    linha(`corrente de desligamento ..... ${antes.limiar} A`);
    linha(`esterçamento max esq/dir ..... ${antes.limiteEsquerdo / 100}° / ${antes.limiteDireito / 100}°`);
    linha(`referencia / trava ........... ${antes.referencia} / ${antes.trava}`);
    linha(`falha ........................ ${antes.falhaNome}`);
    linha(`encoder ...................... ${antes.encoderAcumulado}`);

    // ---- 2. grava o perfil ----
    console.log(`\n2) GRAVANDO O PERFIL "${PERFIL.nome}"\n`);
    const r = await t.gravar(PERFIL);
    for (const p of r.passos) linha(p);

    // ---- 3. confere lendo de volta ----
    console.log('\n3) CONFERINDO (le de volta do modulo)\n');
    const dif = conferir(PERFIL, r.conferencia);
    if (dif.length === 0) {
      linha('todos os campos bateram');
    } else {
      for (const d of dif) linha(`DIVERGIU ${d.nome}: pedi ${d.pedido}, o modulo diz ${d.obtido}`);
    }
    linha(`CPD ${r.conferencia.contagensPorGrau} · Ackerman ${r.conferencia.ackerman} · ` +
          `corrente ${r.conferencia.limiar} A · ` +
          `esterço ${r.conferencia.limiteEsquerdo / 100}°/${r.conferencia.limiteDireito / 100}°`);

    // ---- 4. a gravacao chega na flash? ----
    // O firmware JUNTA as mudancas antes de escrever, entao logo apos gravar o
    // flashPendente e true e isso NAO quer dizer que persistiu. Esperar ate ele
    // cair e o que separa "mandei" de "ficou gravado".
    console.log('\n4) A GRAVACAO CHEGA NA FLASH?\n');
    let ultimo = r.conferencia, esperou = 0;
    while (ultimo.flashPendente && esperou < 8000) {
      await new Promise((x) => setTimeout(x, 400));
      esperou += 400;
      ultimo = await t.ler();
    }
    r.conferencia = ultimo;
    linha(`esperei ${esperou} ms · flashPendente=${ultimo.flashPendente} · flashErro=${ultimo.flashErro}`);
    linha(ultimo.flashErro ? 'ERRO DE FLASH: o modulo nao conseguiu gravar'
          : ultimo.flashPendente ? 'AINDA PENDENTE apos 8 s'
          : 'gravado na flash')

    console.log('\n===== VEREDITO =====\n');
    const ok = dif.length === 0 && !r.recusouLimites && !r.conferencia.flashErro;
    linha(ok ? 'da para configurar o tradutor por fora do AgOpenGPS: SIM'
             : 'algo nao fechou — ver acima');
    console.log('');
    await t.fechar();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    linha('falhou: ' + e.message);
    await t.fechar();
    process.exit(1);
  }
})();
