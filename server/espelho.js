// Modo espelho: o mesmo estimulo nos DOIS firmwares ao mesmo tempo.
//
// O modo simulado tem um ponto fraco conhecido: o firmware e compilado para
// x86, nao para o ESP32. Tipos de inteiro, saturacao e arredondamento PODEM
// diferir — e o defeito que custou o teste de campo de 30/08 era exatamente um
// estouro de int16. Um simulador que erre nisso nao avisa: ele mente calado.
//
// Entao mandamos o mesmo PGN 254/252 para o firmware do PC e para a placa, e
// comparamos byte a byte o PGN 253 que cada um devolve. Igual = o simulador
// merece confianca naquele ponto. Diferente = ou o simulador esta errado, ou o
// hardware faz algo que ninguem previu. Os dois casos interessam.
//
// Para a comparacao ser justa, o motor simulado fica DESLIGADO durante o
// espelho: a placa nao tem motor, entao os dois precisam estar sem encoder.

const aog = require('./aog.js');

class Espelho {
  constructor({ mandarAoSimulado, mandarAPlaca, aoResultado }) {
    this.mandarAoSimulado = mandarAoSimulado;
    this.mandarAPlaca = mandarAPlaca;
    this.aoResultado = aoResultado;
    this.rodando = false;
    this.passos = [];
    this.indice = 0;
    this.respostas = { simulado: [], placa: [] };
    this.divergencias = [];
    this.iguais = 0;
  }

  // Cada passo: manda o estimulo, MANTEM o comando vivo enquanto observa, e
  // compara o que cada lado reporta no fim.
  //
  // Manter vivo e essencial e nao era obvio: o AgOpenGPS de verdade repete o
  // PGN 254 a cada ciclo, e o firmware tem um cao de guarda de 1000 ms. Na
  // primeira versao eu mandava o estimulo uma vez e ficava calado 400 ms —
  // entao o cao de guarda disparava no meio da comparacao, em passos
  // diferentes a cada rodada, e as divergencias pareciam aleatorias porque
  // eram: eram do metodo, nao dos firmwares.
  async rodar(passos) {
    if (this.rodando) {
      // Uma segunda chamada em cima da primeira fazia a rodada anterior
      // terminar pela metade e reportar um placar sem sentido ("8 de 21").
      this.aoResultado({ t: 'espelhoErro', motivo: 'ja existe um espelho rodando' });
      return { iguais: 0, divergencias: [] };
    }
    this.rodando = true;
    this.passos = passos;
    this.divergencias = [];
    this.iguais = 0;

    for (let i = 0; i < passos.length; i++) {
      if (!this.rodando) break;
      const passo = passos[i];
      this.indice = i;

      for (const quadro of passo.enviar) {
        this.mandarAoSimulado(quadro);
        this.mandarAPlaca(quadro);
      }

      const espera = passo.esperaMs || 500;
      // O ultimo quadro do passo e o que sustenta o engate. Passos que testam
      // o cao de guarda pedem `calado` e ficam sem manutencao de proposito.
      const manutencao = passo.calado ? null : ultimoQuadro(passo.enviar);

      const fim = Date.now() + espera;
      while (Date.now() < fim) {
        await pausa(100);
        if (manutencao && Date.now() < fim - 120) {
          this.mandarAoSimulado(manutencao);
          this.mandarAPlaca(manutencao);
        }
      }

      // Compara so o que chegou na ULTIMA janela, ja estabilizado.
      //
      // A janela precisa caber varios relatorios (o modulo manda a 10 Hz) e
      // ainda ser alimentada, senao o cao de guarda entra no meio. Com 320 ms
      // pegavamos 2-3 quadros e uma leitura fora de compasso ja mudava o
      // resultado — dai as divergencias que mudavam de rodada.
      this.respostas = { simulado: [], placa: [] };
      const fimJanela = Date.now() + 700;
      while (Date.now() < fimJanela) {
        await pausa(100);
        if (manutencao && Date.now() < fimJanela - 150) {
          this.mandarAoSimulado(manutencao);
          this.mandarAPlaca(manutencao);
        }
      }

      const s = maisFrequente(this.respostas.simulado);
      const p = maisFrequente(this.respostas.placa);
      const cmp = comparar(passo.nome, s, p);
      if (cmp.igual) this.iguais++;
      else this.divergencias.push(cmp);

      this.aoResultado({
        t: 'espelhoPasso', indice: i, total: passos.length,
        nome: passo.nome, ...cmp,
      });
    }

    this.rodando = false;
    this.aoResultado({
      t: 'espelhoFim',
      iguais: this.iguais,
      divergencias: this.divergencias,
      total: this.passos.length,
    });
    return { iguais: this.iguais, divergencias: this.divergencias };
  }

  parar() { this.rodando = false; }

  registrar(lado, quadro) {
    if (!this.rodando) return;
    const p = aog.parseFromAutoSteer(quadro);
    if (p) this.respostas[lado].push(p);
  }
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// O ultimo PGN 254 do passo — e ele que mantem o engate de pe.
function ultimoQuadro(quadros) {
  for (let i = quadros.length - 1; i >= 0; i--) {
    const q = quadros[i];
    if (q.length >= 14 && q[0] === 0x80 && q[1] === 0x81 && q[3] === 0xFE) return q;
  }
  return null;
}

// A leitura que mais se repete na janela. Um quadro solto fora de compasso
// (o relatorio saindo no meio da mudanca) nao decide a comparacao.
function maisFrequente(lista) {
  if (!lista.length) return null;
  const contas = new Map();
  for (const p of lista) {
    const chave = `${p.anguloX100}|${p.pwm}|${p.chaves}|${p.rumoX10}|${p.rolagemX10}`;
    const c = contas.get(chave) || { n: 0, p };
    c.n++; contas.set(chave, c);
  }
  return [...contas.values()].sort((a, b) => b.n - a.n)[0].p;
}

function comparar(nome, s, p) {
  if (!s || !p) {
    return { igual: false, nome, motivo: !s && !p ? 'nenhum dos dois respondeu'
      : (!s ? 'o simulado nao respondeu' : 'a placa nao respondeu'), simulado: s, placa: p };
  }
  const difs = [];
  if (s.anguloX100 !== p.anguloX100) difs.push(`angulo ${s.anguloX100} vs ${p.anguloX100}`);
  if (s.pwm !== p.pwm) difs.push(`pwm ${s.pwm} vs ${p.pwm}`);
  if (s.chaves !== p.chaves) difs.push(`chaves ${s.chaves} vs ${p.chaves}`);
  if (s.rumoX10 !== p.rumoX10) difs.push(`rumo ${s.rumoX10} vs ${p.rumoX10}`);
  if (s.rolagemX10 !== p.rolagemX10) difs.push(`rolagem ${s.rolagemX10} vs ${p.rolagemX10}`);
  return { igual: difs.length === 0, nome, motivo: difs.join(' · '), simulado: s, placa: p };
}

// ---------------------------------------------------------------------------
// O roteiro. Cada passo e um estimulo que ja mordeu alguem em algum momento.
// ---------------------------------------------------------------------------
function roteiro() {
  const cfg = (o) => aog.steerSettings({ ganhoP: 40, pwmAlto: 180, pwmBaixo: 30,
    pwmMinimo: 25, contagensPorGrau: 100, offsetDirecao: 0, ackerman: 100, ...o });
  const cmd = (o) => aog.steerData({ velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 0, xte: 0, ...o });

  return [
    // Passo zero, obrigatorio: soltar o pedido de engate ANTES de qualquer
    // coisa. A trava de seguranca do firmware so cai na borda de descida
    // (`engateDecidir`), entao um teste que engata direto pode estar rodando
    // em cima de trava herdada da sessao anterior e ver o modulo "morto".
    // Foi o que derrubou o AogFake em 01/09 — e derrubou este espelho tambem,
    // ate a placa passar a reportar 100 (o CPD de repouso) em vez do PWM.
    { nome: 'solta o pedido (destrava a seguranca)', enviar: [cfg({}), cmd({ engatar: false })], esperaMs: 700 },
    { nome: 'parado, sem engate', enviar: [cfg({}), cmd({ engatar: false })] },
    { nome: 'engatado, alvo 0', enviar: [cmd({ anguloAlvoGraus: 0 })] },
    { nome: 'alvo 2 graus, Kp 40 (espera pwm 80)', enviar: [cfg({ ganhoP: 40 }), cmd({ anguloAlvoGraus: 2 })] },
    { nome: 'mesmo alvo, Kp 20 (espera pwm 40)', enviar: [cfg({ ganhoP: 20 }), cmd({ anguloAlvoGraus: 2 })] },
    { nome: 'alvo negativo -2 graus', enviar: [cfg({ ganhoP: 40 }), cmd({ anguloAlvoGraus: -2 })] },
    { nome: 'zona morta: alvo 0,3 grau', enviar: [cmd({ anguloAlvoGraus: 0.3 })] },
    { nome: 'saturacao: alvo 40 graus', enviar: [cmd({ anguloAlvoGraus: 40 })] },
    { nome: 'saturacao negativa: alvo -40', enviar: [cmd({ anguloAlvoGraus: -40 })] },
    { nome: 'pwm alto baixo (60) satura antes', enviar: [cfg({ pwmAlto: 60 }), cmd({ anguloAlvoGraus: 40 })] },
    { nome: 'pwm minimo alto (100) mata correcao pequena', enviar: [cfg({ pwmAlto: 180, pwmMinimo: 100 }), cmd({ anguloAlvoGraus: 1 })] },
    // CPD baixo: e a causa raiz do teste de campo de 30/08
    { nome: 'CPD 1 (o que quebrou em 30/08)', enviar: [cfg({ contagensPorGrau: 1 }), cmd({ anguloAlvoGraus: 10 })] },
    { nome: 'CPD 2', enviar: [cfg({ contagensPorGrau: 2 }), cmd({ anguloAlvoGraus: 10 })] },
    { nome: 'CPD 255 (extremo oposto)', enviar: [cfg({ contagensPorGrau: 255 }), cmd({ anguloAlvoGraus: 10 })] },
    { nome: 'offset grande (+3000)', enviar: [cfg({ contagensPorGrau: 100, offsetDirecao: 3000 }), cmd({ anguloAlvoGraus: 0 })] },
    { nome: 'offset negativo (-3000)', enviar: [cfg({ offsetDirecao: -3000 }), cmd({ anguloAlvoGraus: 0 })] },
    { nome: 'volta ao normal', enviar: [cfg({ offsetDirecao: 0 }), cmd({ anguloAlvoGraus: 0 })] },
    { nome: 'desengate pelo status', enviar: [cmd({ engatar: false, anguloAlvoGraus: 10 })] },
    { nome: 'cao de guarda: 1,5 s sem PGN 254', enviar: [], esperaMs: 1600, calado: true },
    { nome: 'volta depois do cao de guarda', enviar: [cmd({ anguloAlvoGraus: 5 })] },
    { nome: 'velocidade alta (25 km/h)', enviar: [cmd({ velocidadeKmh: 25, anguloAlvoGraus: 5 })] },
  ];
}

// ---------------------------------------------------------------------------
// Roteiro de estresse: quadro torto, lixo no fio, rajada e valor extremo.
// Aqui nao se espera "o valor certo" — espera-se que os dois lados reajam
// IGUAL, e que nenhum dos dois trave. Firmware costuma quebrar exatamente
// nestas bordas, e no fio de verdade elas acontecem: cabo mal encaixado, o
// AgIO abrindo a porta no meio de um quadro, ruido eletrico do trator.
// ---------------------------------------------------------------------------
function roteiroEstresse() {
  const cfg = (o) => aog.steerSettings({ ganhoP: 40, pwmAlto: 180, pwmBaixo: 30,
    pwmMinimo: 25, contagensPorGrau: 100, offsetDirecao: 0, ackerman: 100, ...o });
  const cmd = (o) => aog.steerData({ velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 0, xte: 0, ...o });

  const normal = cmd({ anguloAlvoGraus: 5 });

  // quadro com o CRC trocado de proposito
  const crcRuim = Buffer.from(normal); crcRuim[13] = (crcRuim[13] + 7) & 0xFF;
  // quadro que diz ter mais dados do que tem
  const tamanhoMentiroso = Buffer.from(normal); tamanhoMentiroso[4] = 40;
  // PGN que o modulo nao conhece
  const pgnDesconhecido = Buffer.from(normal); pgnDesconhecido[3] = 0xAA;
  // so o cabecalho, sem o resto
  const soCabecalho = normal.subarray(0, 5);
  // lixo puro
  const lixo = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
  // lixo colado na frente de um quadro bom
  const lixoMaisQuadro = Buffer.concat([lixo, normal]);
  // dois quadros bons colados
  const doisJuntos = Buffer.concat([cmd({ anguloAlvoGraus: 3 }), cmd({ anguloAlvoGraus: 7 })]);

  const passos = [
    { nome: 'base: alvo 5 graus', enviar: [cfg({}), normal] },
    { nome: 'CRC errado (deve ignorar ou aceitar — mas IGUAL)', enviar: [crcRuim] },
    { nome: 'volta ao normal depois do CRC errado', enviar: [normal] },
    { nome: 'tamanho mentiroso no cabecalho', enviar: [tamanhoMentiroso] },
    { nome: 'recuperacao depois do tamanho mentiroso', enviar: [normal], esperaMs: 700 },
    { nome: 'PGN desconhecido (0xAA)', enviar: [pgnDesconhecido] },
    { nome: 'so o cabecalho, sem dados', enviar: [soCabecalho] },
    { nome: 'recuperacao depois do cabecalho solto', enviar: [normal], esperaMs: 700 },
    { nome: 'lixo puro no fio', enviar: [lixo] },
    { nome: 'lixo colado antes de um quadro bom', enviar: [lixoMaisQuadro] },
    { nome: 'dois quadros colados (alvo 3 e 7)', enviar: [doisJuntos] },
    { nome: 'CPD 0 (divisao por zero se ninguem tratar)', enviar: [cfg({ contagensPorGrau: 0 }), normal] },
    { nome: 'recuperacao com CPD 100', enviar: [cfg({ contagensPorGrau: 100 }), normal] },
    { nome: 'alvo no extremo do int16 (+327 graus)', enviar: [cmd({ anguloAlvoGraus: 327 })] },
    { nome: 'alvo no extremo negativo (-327 graus)', enviar: [cmd({ anguloAlvoGraus: -327 })] },
    { nome: 'pwmAlto 255 (teto maximo)', enviar: [cfg({ pwmAlto: 255 }), cmd({ anguloAlvoGraus: 40 })] },
    { nome: 'pwmMinimo maior que pwmAlto', enviar: [cfg({ pwmAlto: 30, pwmMinimo: 200 }), cmd({ anguloAlvoGraus: 40 })] },
    { nome: 'ganho 255 (maximo)', enviar: [cfg({ pwmAlto: 180, pwmMinimo: 25, ganhoP: 255 }), cmd({ anguloAlvoGraus: 1 })] },
    { nome: 'ganho 0 (nao deve acionar)', enviar: [cfg({ ganhoP: 0 }), cmd({ anguloAlvoGraus: 40 })] },
    { nome: 'volta ao normal', enviar: [cfg({ ganhoP: 40 }), normal] },
  ];

  // rajada: 30 quadros de uma vez, alternando o alvo
  const rajada = [];
  for (let i = 0; i < 30; i++) rajada.push(cmd({ anguloAlvoGraus: i % 2 ? 8 : -8 }));
  passos.push({ nome: 'rajada de 30 quadros alternando o alvo', enviar: rajada, esperaMs: 900 });
  passos.push({ nome: 'estado depois da rajada', enviar: [normal] });

  // liga e desliga rapido, muitas vezes
  const pisca = [];
  for (let i = 0; i < 20; i++) pisca.push(cmd({ engatar: i % 2 === 0, anguloAlvoGraus: 5 }));
  passos.push({ nome: 'engata e desengata 20 vezes seguidas', enviar: pisca, esperaMs: 900 });
  passos.push({ nome: 'estado depois do pisca-pisca', enviar: [normal] });

  return passos;
}

module.exports = { Espelho, roteiro, roteiroEstresse };
