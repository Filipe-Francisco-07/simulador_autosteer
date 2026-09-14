// Servidor do simulador.
//
// Amarra quatro coisas num relogio so:
//   1. o FIRMWARE REAL, rodando como processo (sim/firmware_sim.exe)
//   2. o AgOpenGPS simulado — linha AB, erro lateral e o PGN 254 de cada ciclo
//   3. o motor Keya simulado — a fisica do motor e da coluna de direcao
//   4. o TRATOR — onde ele esta, para onde aponta, marcha e velocidade
//
// A malha fecha de verdade: a linha AB diz o angulo desejado, o firmware
// traduz para o motor, o motor gira as rodas, o trator anda e sai um erro
// lateral novo. E o mesmo ciclo do campo, com o firmware de verdade no meio.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { MotorKeya } = require('./motor.js');
const { Trator, LinhaAB, MARCHAS } = require('./trator.js');
const { Placa, listarPortas, BAUD_PADRAO } = require('./placa.js');
const { Espelho, roteiro, roteiroEstresse } = require('./espelho.js');
const aog = require('./aog.js');
const { CalibradorPorGps } = require('./calibrador.js');

const PORTA = 3000;
const PASSO_MS = 20;           // cadencia real do heartbeat do Keya
const EXE = path.join(__dirname, '..', 'sim', 'firmware_sim.exe');

if (!fs.existsSync(EXE)) {
  console.error('\nFirmware nao compilado. Rode:  npm run build\n');
  process.exit(1);
}

// ------------------------------------------------------------- estado global
const motor = new MotorKeya();
const trator = new Trator();
const linha = new LinhaAB();

let aogLigado = true;          // o AOG esta mandando PGN? (desligar = cabo caido)
let pilotoPedido = false;      // o operador apertou engatar
let comandoAog = { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 };
// O que o AOG manda no PGN 252. O CPD nasce em 19 porque e o que o batente
// medido no JD 5078 em 05/09 implica: 760 contagens do centro ate o fim de
// curso, que sao ~40 graus de roda. Ficou 100 aqui por muito tempo, herdado do
// padrao de tela do AOG, e isso mentia de dois jeitos ao mesmo tempo — o angulo
// saia 5x menor E o volante na mao estourava o teto de salto de encoder do
// firmware, derrubando a referencia sem que nada na tela explicasse.
let ajustesAog = { ganhoP: 40, pwmAlto: 180, pwmBaixo: 30, pwmMinimo: 25,
                   contagensPorGrau: 19, offsetDirecao: 0, ackerman: 100 };
let motorRespondendo = true;   // o Keya esta mandando heartbeat?

// Mede o esterçamento pelo GPS enquanto o trator anda, sem sensor nas rodas.
// Roda sempre, calado; so responde quando o passeio deu material suficiente.
// No trator de verdade ele vive no mesmo lugar: quem tem posicao e encoder ao
// mesmo tempo e o PC do AgOpenGPS, nao o ESP32.
const calibrador = new CalibradorPorGps({ entreEixos: trator.entreEixos });
let ruidoGpsM = 0.02;   // RTK fixed. Subir aqui simula GPS ruim de propósito.
let contaGps = 0;

// Ruido gaussiano (Box-Muller). O erro de RTK nao e uniforme: e uma nuvem em
// volta da posicao certa, e usar uniforme aqui deixaria o metodo parecer melhor
// do que ele e no campo.
function gaussiana() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
let estadoFirmware = {};
let pwmRealDaPlaca = 0;      // vem do comando CAN ecoado (so no firmware de bancada)
let ultimoEnableDaPlaca = 0; // quando a placa mandou o ultimo ENABLE ao motor
let ultimoPgn253 = null;
// Ultimo AP01 que o modulo respondeu. E o unico jeito de ver o interior dele
// sem o firmware de bancada — e no trator e daqui que sai a contagem de encoder
// que o calibrador por GPS precisa.
let ultimoDiagnostico = null;
let marcaDiagnostico = 0;
let proximoDiagnostico = 0;
let contadores = { pgn253: 0, canCmd: 0 };

// ---- de onde vem o firmware -----------------------------------------------
// 'simulado' = o main.cpp compilado rodando aqui, com o motor Keya de mentira
//              e a malha fechando inteira.
// 'placa'    = o ESP32 de verdade na USB. Testa a serial, o baud e o tempo
//              real, mas SO a camada AOG<->modulo: o motor mora no barramento
//              CAN, que o PC nao ve.
let modo = 'simulado';
let placaEstado = { estado: 'desligada', caminho: null, baud: BAUD_PADRAO, erro: null };
let textoDaPlaca = [];
// A porta abrir nao quer dizer que o modulo esta do outro lado: os CH340 do
// projeto nao tem numero de serie e trocam de COM ao mudar de tomada. Se em
// alguns segundos nao chegar nenhum PGN, e porta errada ou baud errado — e o
// operador precisa saber disso, nao ficar olhando uma tela parada.
let ultimoPgnDaPlaca = 0;
let placaMuda = false;

const placa = new Placa({
  aoReceberPgn: (quadro) => {
    espelho.registrar('placa', quadro);
    const d = aog.parseDiagnostico(quadro);
    if (d && d.crcOk && d.etiqueta === 'AP01') ultimoDiagnostico = { ...d, quando: Date.now() };
    const p = aog.parseFromAutoSteer(quadro);
    ultimoPgnDaPlaca = Date.now();
    if (placaMuda) {
      placaMuda = false;
      transmitir({ t: 'placa', ...placaEstado, muda: false });
    }
    if (p) { ultimoPgn253 = p; contadores.pgn253++; }
    // Sem acesso as variaveis internas, o estado vem do que a placa reporta.
    if (p) {
      // SO o que a placa realmente diz. Antes eu carregava o resto do estado
      // do modo simulado junto (corrente, encoder, trava), e a tela mostrava
      // numero velho como se fosse leitura da placa — mentira que atrapalha
      // justamente quem esta testando.
      estadoFirmware = {
        ...estadoFirmware,
        anguloAtualX100: p.anguloX100,
        // na bancada o PWM verdadeiro vem do comando CAN; sem ele, o byte de
        // diagnostico e o que ha — e ele vira CODIGO DE FALHA com o motor parado
        // (mudou em 07/09; antes era o CPD em uso)
        pwmSaida: placa.temBancada ? pwmRealDaPlaca : p.pwm,
        // "esta acionando?" na placa: mandou ENABLE ha menos de 600 ms.
        // O firmware manda comando CAN a cada 50 ms, entao 600 ms de silencio
        // ja e sinal claro de que parou. Uma janela maior atrasa a leitura e
        // faz um desengate correto parecer falha.
        autosteerLigado: placa.temBancada
          ? (Date.now() - ultimoEnableDaPlaca < 600)
          : undefined,
        byteDiagnostico: p.diagnostico,
        // com PWM real conhecido da para dizer se o byte e falha ou acionamento
        falhaDaPlaca: placa.temBancada && pwmRealDaPlaca === 0
          ? p.falhaSeParado
          : (p.diagnostico === 0 ? 'nenhuma' : undefined),
        chaves: p.chaves,
        deQuem: 'placa',
      };
    }
    transmitir({ t: 'quadro', via: 'serial', hex: quadro.toString('hex').toUpperCase(), decodificado: p });
  },
  aoTexto: (t) => {
    textoDaPlaca.push(t);
    if (textoDaPlaca.length > 40) textoDaPlaca.shift();
    transmitir({ t: 'textoPlaca', texto: t });
  },
  // O firmware de bancada ecoa o comando que mandaria ao motor. Com ele o
  // motor simulado obedece o comando EXATO, em vez de deduzir o sentido pelo
  // modulo do PWM que o PGN 253 reporta.
  aoComandoCan: (dados) => {
    motor.receberComando(0, dados.toString('hex'));
    // Quando o firmware desengata ele manda velocidade 0 + DISABLE. Entao o
    // ENABLE e a prova de que ele esta acionando o motor AGORA — o unico sinal
    // confiavel de engate na placa, ja que as variaveis internas nao saem de la.
    const h = dados.toString('hex').toUpperCase();
    if (h.startsWith('230D2001')) ultimoEnableDaPlaca = Date.now();
    contadores.canCmd++;
    // O comando de velocidade diz o PWM de verdade, com sinal — o campo do
    // PGN 253 vira o CPD quando o PWM e zero, entao nao serve sozinho.
    const vel = aog.velocidadeDoComandoKeya(dados);
    if (vel !== null) {
      pwmRealDaPlaca = Math.round(vel * 255 / 998) * -1;   // desfaz o SENTIDO=-1
      estadoFirmware = { ...estadoFirmware, pwmSaida: pwmRealDaPlaca, deQuem: 'placa' };
    }
    transmitir({ t: 'quadro', via: 'can', hex: dados.toString('hex').toUpperCase() });
  },
  aoEstado: (estado, erro) => {
    placaEstado = { ...placaEstado, estado, erro: erro || null,
                    caminho: placa.caminho, baud: placa.baud };
    transmitir({ t: 'placa', ...placaEstado });
  },
});

// Volante na mao do operador (teclas A e D)
let estercandoEsq = false, estercandoDir = false;

// Atraso artificial no caminho do motor.
//
// Serve para responder uma pergunta concreta: quanto atraso a malha aguenta
// antes de comecar a oscilar? Na bancada com a placa, o heartbeat e o comando
// atravessam a USB duas vezes (~25 ms medidos), e isso e do ARRANJO, nao do
// trator — la o modulo fala CAN direto com o motor. Podendo reproduzir o
// atraso no simulado, da para separar o que e defeito do que e mesa.
let atrasoMotorMs = 0;
const filaHeartbeat = [];

// --- as duas chaves do bug da re (ver docs do AgroPreciso) -----------------
// isReverseOn      = o AOG DETECTA que esta de re (Config > Dados)
// isSteerInReverse = o piloto CONTINUA estercando de re (tela de direcao)
let isReverseOn = true;
let isSteerInReverse = false;

// o que o AOG "acha" que esta acontecendo
let aogEmRe = false;
let rumoQueOAogUsa = 0;
let mostrador = { xte: 0, alvo: 0 };

// ------------------------------------------------------------- firmware
let fw = null;
let bufferSaida = '';

function iniciarFirmware() {
  fw = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  fw.stdout.on('data', (chunk) => {
    bufferSaida += chunk.toString();
    let i;
    while ((i = bufferSaida.indexOf('\n')) >= 0) {
      const l = bufferSaida.slice(0, i).trim();
      bufferSaida = bufferSaida.slice(i + 1);
      if (l) tratarSaidaFirmware(l);
    }
  });
  fw.stderr.on('data', (d) => console.error('[firmware]', d.toString().trim()));
  fw.on('exit', (c) => console.error('[firmware] encerrou, codigo', c));
}

const manda = (l) => { if (fw && fw.stdin.writable) fw.stdin.write(l + '\n'); };

function tratarSaidaFirmware(l) {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  if (m.t === 'can_tx') {
    contadores.canCmd++;
    motor.receberComando(m.id, m.hex);
    transmitir({ t: 'quadro', via: 'can', hex: m.hex });
  } else if (m.t === 'serial_tx') {
    for (const q of aog.separarQuadros(Buffer.from(m.hex, 'hex'))) {
      espelho.registrar('simulado', q);
      const d = aog.parseDiagnostico(q);
      if (d && d.crcOk && d.etiqueta === 'AP01') ultimoDiagnostico = { ...d, quando: Date.now() };
      const p = aog.parseFromAutoSteer(q);
      if (p) { ultimoPgn253 = p; contadores.pgn253++; }
      transmitir({ t: 'quadro', via: 'serial', hex: q.toString('hex').toUpperCase(), decodificado: p });
    }
  } else if (m.t === 'state') {
    estadoFirmware = m;
  }
}

// ------------------------------------------------------------- o AOG pensando
// Reproduz a decisao de re do AgOpenGPS (Position.designer.cs:387 e :471):
// ele compara o rumo do GPS com o rumo verdadeiro. Com a deteccao DESLIGADA
// ele assume que esta sempre indo para frente — e ai o rumo fica invertido na
// re, que e o sintoma do chamado 7.
function pensarComoAog() {
  const rumoGps = trator.rumoDoGps();

  if (isReverseOn) {
    let delta = Math.abs(rumoGps - trator.rumo);
    while (delta > Math.PI) delta = Math.abs(delta - 2 * Math.PI);
    aogEmRe = delta > 1.57;
    rumoQueOAogUsa = aogEmRe ? (rumoGps + Math.PI) % (2 * Math.PI) : rumoGps;
  } else {
    aogEmRe = false;
    rumoQueOAogUsa = rumoGps;      // na re isto aponta para tras: o bug
  }

  // O AOG guia usando o rumo que ELE acha. Montamos um trator "de mentira"
  // com esse rumo para calcular o angulo — assim o erro do AOG aparece no
  // comando, como acontece de verdade.
  const comoOAogVe = { x: trator.x, y: trator.y, rumo: rumoQueOAogUsa };
  const mira = Math.max(3, Math.abs(trator.velocidade) * 0.7);
  const alvo = linha.anguloDesejado(comoOAogVe, mira, trator.entreEixos, trator.velocidade);

  mostrador = { xte: linha.erroLateral(trator), alvo };

  let engatar = pilotoPedido && linha.pronta;
  if (engatar && !isSteerInReverse && aogEmRe) engatar = false;  // solta na re

  comandoAog = {
    velocidadeKmh: Math.abs(trator.velocidade),
    engatar,
    anguloAlvoGraus: alvo,
    xte: Math.max(-127, Math.min(127, Math.round(mostrador.xte * 100))),
  };
}

// ------------------------------------------------------------- espelho
// Compara o firmware do PC com o da placa sob o mesmo estimulo.
const espelho = new Espelho({
  mandarAoSimulado: (quadro) => manda('S ' + quadro.toString('hex').toUpperCase()),
  mandarAPlaca: (quadro) => placa.enviar(quadro),
  aoResultado: (msg) => transmitir(msg),
});

async function rodarEspelho(qual) {
  if (!placa.ligada) {
    transmitir({ t: 'espelhoErro', motivo: 'a placa precisa estar conectada' });
    return;
  }
  // Comparacao justa exige o MESMO estado dos dois lados — e desligar o motor
  // nao dava isso. Sem heartbeat, o cao de guarda do motor so age em quem ja
  // viu o motor alguma vez (`keyaVisto`), e esse historico difere entre a placa
  // e o processo recem-reiniciado. O resultado eram divergencias que pareciam
  // do firmware e eram de estado.
  //
  // Com o firmware de bancada o motor simulado alimenta OS DOIS com o mesmo
  // heartbeat, entao manter ligado e mais justo e mais parecido com o trator.
  const motorAntes = motorRespondendo;
  const aogAntes = aogLigado;
  motorRespondendo = placa.temBancada;   // na bancada os dois recebem o motor
  aogLigado = false;                     // so o espelho fala com os firmwares
  manda('R');                 // simulado do zero
  placa.reiniciar();          // placa do zero
  await new Promise((r) => setTimeout(r, 2500));

  const passos = qual === 'estresse' ? roteiroEstresse() : roteiro();
  const r = await espelho.rodar(passos);

  motorRespondendo = motorAntes;
  aogLigado = aogAntes;
  return r;
}

// ------------------------------------------------------------- laco principal
let tique = 0;
let ultimoTique = Date.now();

// Teto de um passo. Se o Node engasgar (coleta de lixo, uma aba pesada), sem
// isto o firmware receberia um salto de segundos de uma vez.
const PASSO_MAXIMO_MS = 250;

setInterval(() => {
  tique++;
  const naPlaca = modo === 'placa';

  // Quanto tempo passou DE VERDADE desde o ultimo tique.
  //
  // Avancar 20 ms fixos parecia certo e nao era: o setInterval do Node nunca
  // acerta o intervalo, e o relogio do simulado ficava 1,37x mais lento que o
  // mundo. Na pratica o cao de guarda de 1000 ms so vencia depois de ~1370 ms
  // reais — e a placa, que anda no relogio dela, desengatava antes. Foi assim
  // que a comparacao com o hardware apontou o defeito.
  const agora = Date.now();
  const decorrido = Math.min(PASSO_MAXIMO_MS, agora - ultimoTique);
  ultimoTique = agora;

  // 1. o tempo anda no firmware. Na placa o tempo e o do mundo — nao ha o que
  //    adiantar, e o ESP32 roda no proprio relogio dele.
  //    No espelho os dois precisam correr, entao o simulado tambem avanca.
  if (!naPlaca || espelho.rodando) manda('T ' + decorrido);

  // 2. o operador no volante.
  //
  // Isto rodava so com o piloto DESLIGADO, e essa guarda tornava impossivel
  // reproduzir um override: override E girar o volante com o piloto engatado.
  // O operador nao pede licenca ao modulo — ele pega o volante e vira. Sem
  // isso o cenario "mao no volante" da suite nunca foi um override de verdade:
  // ele so mudava uma leitura de corrente, e passava porque a planta antiga
  // (CPD 100) era lenta o bastante para o PWM ficar alto o tempo todo.
  //
  // Com o piloto engatado o operador nao vence sozinho: o motor puxa de volta.
  // Quem decide o resultado e a disputa entre os dois, e e justamente essa
  // disputa que levanta a corrente e dispara o desengate.
  {
    const taxa = 32 * (decorrido / 1000);   // graus por segundo no volante
    if (estercandoEsq) motor.girarManual(-taxa);
    if (estercandoDir) motor.girarManual(+taxa);
  }

  // 3. a fisica do motor e do trator.
  //
  // O trator sempre segue a roda FISICA, nunca o que o firmware acha dela.
  // No modo placa essa roda so se move pela mao do operador (A e D), porque o
  // motor de verdade esta no barramento CAN, fora do alcance do PC. E ai o
  // painel fica honesto: voce vira o volante, o trator vira, e o campo
  // "firmware acha" continua em zero — mostrando que a placa nao faz ideia de
  // onde a roda esta enquanto o motor nao estiver nela.
  motor.passo(decorrido);
  trator.anguloRodas = motor.anguloRodasGraus;
  trator.passo(decorrido);

  // 3b. o calibrador olha o mundo pelo GPS, como faria no trator.
  //
  // Recebe POSICAO com ruido de RTK, nao o angulo real — se recebesse o angulo
  // nao estaria medindo nada, so devolvendo o que ja sabemos. O ruido entra aqui
  // e nao no trator porque o trator anda pela fisica exata; quem erra e o
  // receptor, e o erro dele e o que o metodo tem que aguentar.
  contaGps += decorrido;
  if (contaGps >= 100) {                 // 10 Hz, como o AOG recebe
    contaGps = 0;
    // As contagens tem que ser as QUE O MODULO USA, nao as cruas do motor.
    // O firmware acumula o delta do encoder com sentido -1; alimentar o cru
    // fazia o calibrador acusar "motor ao contrario" numa montagem correta,
    // porque ele via o acumulador crescer ao contrario do angulo. Com o
    // acumulador do modulo, "invertido" passa a querer dizer o que interessa:
    // a conta que o modulo faz cresce para o lado errado.
    //
    // A fonte preferida e o quadro de diagnostico AP01, porque ele funciona
    // IGUAL na placa com firmware de producao — que e onde isto vai rodar no
    // trator. O estado do processo so existe no modo simulado, e fica como
    // reserva para quando a resposta do diagnostico atrasar.
    const doDiagnostico = ultimoDiagnostico
      && (agora - ultimoDiagnostico.quando) < 1500
      ? ultimoDiagnostico.encoderAcumulado : null;
    const contagens = doDiagnostico != null ? doDiagnostico : estadoFirmware.encoderAcumulado;
    if (contagens != null) {
      calibrador.observarPosicao({
        t: agora,
        x: trator.x + gaussiana() * ruidoGpsM,
        y: trator.y + gaussiana() * ruidoGpsM,
        velocidadeKmh: trator.velocidade,
        contagens,
      });
    }
  }

  // 4. o motor manda heartbeat.
  //
  // No simulado vai para o processo. Na placa COM FIRMWARE DE BANCADA vai pela
  // USB, e o ESP32 injeta no proprio barramento — e assim a malha fecha com o
  // tradutor de verdade no meio. Com o firmware de producao nao ha caminho: o
  // CAN e fisico, e o angulo fica em zero.
  if (motorRespondendo) {
    const hb = motor.heartbeat();
    const entrega = () => {
        // No espelho os dois firmwares precisam do mesmo heartbeat.
      if (espelho.rodando) {
        manda('C ' + hb.id + ' ' + hb.hex);
        if (placa.temBancada) placa.injetarHeartbeat(hb.hex);
      } else if (naPlaca) {
        if (placa.temBancada) placa.injetarHeartbeat(hb.hex);
      } else {
        manda('C ' + hb.id + ' ' + hb.hex);
      }
    };
    // A fila modela um transporte de latencia FIXA. Ela e esvaziada quando a
    // latencia muda (ver o comando 'atrasoMotor'), entao aqui basta entregar o
    // que venceu.
    if (atrasoMotorMs > 0) {
      filaHeartbeat.push({ quando: agora + atrasoMotorMs, entrega });
      while (filaHeartbeat.length && filaHeartbeat[0].quando <= agora) filaHeartbeat.shift().entrega();
    } else {
      entrega();
    }
  }

  // 5. o AOG decide e manda o comando do ciclo.
  //    Durante o espelho o laco fica calado: quem fala com os firmwares e o
  //    roteiro, senao o comando do trator se mistura ao estimulo do teste.
  pensarComoAog();
  if (aogLigado && !espelho.rodando) {
    const quadro = aog.steerData(comandoAog);
    if (naPlaca) placa.enviar(quadro);
    else manda('S ' + quadro.toString('hex').toUpperCase());
  }

  // 5b. pergunta o estado interno ao modulo, 2x por segundo.
  //
  // O PGN 253 leva angulo, chaves e UM byte. Tudo o mais — encoder acumulado,
  // saltos, limites, CPD e Ackerman vigentes, flash — so sai por aqui. Na placa
  // com firmware de producao era exatamente isso que o painel nao tinha, e
  // mostrava tracinho.
  //
  // NAO perguntar durante o espelho: la o roteiro e quem fala, e um quadro a
  // mais no fio bagunca a comparacao entre os dois firmwares.
  if (!espelho.rodando && agora >= proximoDiagnostico) {
    proximoDiagnostico = agora + 500;
    marcaDiagnostico = (marcaDiagnostico + 1) & 0xFF;
    const q = aog.servico(aog.OPS_SERVICO.LER, { marca: marcaDiagnostico });
    if (naPlaca) placa.enviar(q);
    else manda('S ' + q.toString('hex').toUpperCase());
  }

  // a placa esta viva? (so avisa uma vez, quando o silencio comeca)
  if (naPlaca && !placaMuda && Date.now() - ultimoPgnDaPlaca > 3000) {
    placaMuda = true;
    transmitir({ t: 'placa', ...placaEstado, muda: true });
  }

  // 6. estado para a tela, a 25 Hz (o mapa fica suave)
  if (!naPlaca) manda('Q');
  if (tique % 2 === 0) transmitir(quadroDaTela());
}, PASSO_MS);

const naPlacaAgora = () => modo === 'placa';

function quadroDaTela() {
  const cal = calibrador.resultado();
  return {
    t: 'tela',
    firmware: estadoFirmware,
    // O que o GPS diz do esterçamento, independente do encoder. E a unica
    // leitura da tela que nao vem do modulo: serve justamente para conferir o
    // modulo.
    // O que o modulo respondeu sobre si mesmo (PGN 239 AP01). Envelhece: se
    // parar de responder, a tela precisa saber que o numero e velho.
    diagnostico: ultimoDiagnostico && (Date.now() - ultimoDiagnostico.quando < 3000)
      ? ultimoDiagnostico : null,
    calibragem: cal.pronto ? {
      ...cal,
      laudo: calibrador.laudo(ajustesAog.contagensPorGrau, estadoFirmware.centro),
    } : cal,
    motor: {
      anguloRodasGraus: motor.anguloRodasGraus,
      posicaoMotor: motor.posicaoMotor,
      velocidadeAtual: motor.velocidadeAtual,
      habilitado: motor.habilitado,
      corrente: motor.correnteAtual(),
      escorregamento: motor.escorregamento,
      folgaGraus: motor.folgaGraus,
      contagensPorGrauReal: motor.contagensPorGrauReal,
      maoNoVolante: motor.maoNoVolante,
      travado: motor.travado,
      batenteGraus: motor.batenteGraus,
      sentidoMontagem: motor.sentidoMontagem,
      voltasPorSegundoMax: motor.voltasPorSegundoMax,
      atrasoMotorMs,
      alimentandoPlaca: naPlacaAgora() && placa.temBancada,
      noBatente: motor.noBatente,
      erro: motor.erro,
    },
    trator: {
      x: trator.x, y: trator.y, rumo: trator.rumo,
      velocidade: trator.velocidade, marcha: trator.nomeMarcha,
      marchaEhRe: trator.velocidadeMaxima < 0,
      maxMarcha: trator.velocidadeMaxima, percorrido: trator.percorrido,
      rastro: trator.rastro.slice(-900),
    },
    guia: {
      temLinha: linha.pronta, a: linha.a, b: linha.b, rumoLinha: linha.rumoLinha,
      largura: linha.largura, passada: linha.passadaAtual(trator),
      xte: mostrador.xte, alvo: mostrador.alvo,
      pilotoPedido, aogEmRe, rumoQueOAogUsa, isReverseOn, isSteerInReverse,
    },
    aog: { ligado: aogLigado, comando: comandoAog, ajustes: ajustesAog,
           ultimoPgn253, motorRespondendo },
    modo, placa: { ...placaEstado, muda: placaMuda, bancada: placa.temBancada },
    contadores,
  };
}

// ------------------------------------------------------------- web
const clientes = new Set();
function transmitir(msg) {
  const s = JSON.stringify(msg);
  for (const c of clientes) if (c.readyState === 1) c.send(s);
}

const RAIZ_WEB = path.join(__dirname, '..', 'web');

const servidor = http.createServer((req, res) => {
  const arquivo = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
  const caminho = path.join(RAIZ_WEB, arquivo);
  if (!caminho.startsWith(RAIZ_WEB) || !fs.existsSync(caminho)) {
    res.writeHead(404); res.end('nao encontrado'); return;
  }
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'Content-Type': tipos[path.extname(caminho)] || 'text/plain' });
  fs.createReadStream(caminho).pipe(res);
});

const wss = new WebSocketServer({ server: servidor });
wss.on('connection', (ws) => {
  clientes.add(ws);
  ws.on('close', () => clientes.delete(ws));
  // Quem chega agora precisa ver o estado REAL do servidor, nao o que esta
  // escrito no HTML: senao abrir uma aba nova mostra chave desligada enquanto
  // o simulador continua com o cabo cortado, e o teste sai errado.
  ws.send(JSON.stringify({ t: 'sincronizar', aogLigado, motorRespondendo,
    ajustes: ajustesAog, marchas: MARCHAS.map((m) => m.nome), largura: linha.largura,
    modo, placa: placaEstado, textoDaPlaca,
    isReverseOn, isSteerInReverse, pilotoPedido,
    motor: { maoNoVolante: motor.maoNoVolante, travado: motor.travado,
             escorregamento: motor.escorregamento, sentidoMontagem: motor.sentidoMontagem,
             contagensPorGrauReal: motor.contagensPorGrauReal,
             batenteGraus: motor.batenteGraus, correnteMao: motor.correnteMao,
             voltasPorSegundoMax: motor.voltasPorSegundoMax,
             erro: motor.erro } }));
  ws.on('message', (d) => {
    let c; try { c = JSON.parse(d.toString()); } catch { return; }
    aplicarComando(c);
  });
});

// O AgIO manda os ajustes do perfil do trator assim que acha o modulo. O
// simulador nao fazia isso: so mandava PGN 252 quando alguem mexia num controle
// da tela. Resultado — o firmware rodava com os padroes DELE (CPD 100, Kp 40,
// PWM alto 162) enquanto o painel exibia os valores do servidor, e ninguem via
// a diferenca. Toda medida de sintonia feita antes disto media outro ganho que
// nao o mostrado. Um atraso curto porque o modulo precisa terminar o setup().
function mandarAjustesQuandoSubir() {
  setTimeout(() => { mandarAjustes(); mandarConfig(); }, 300);
}

// Configuracao do trator (PGN 251). O AgIO manda os dois quadros, 252 e 251, e
// o simulador so mandava o 252 — entao limiar de corrente, velocidade minima e
// os bits de configuracao nunca foram exercitados aqui. set0 = 56 e o padrao de
// fabrica do AgOpenGPS e o que os perfis do trator mandam.
let configAog = { set0: 56, maxPulse: 0, minSpeedKmh: 0, set1: 0 };

function mandarConfig() {
  const quadro = aog.steerConfig(configAog);
  if (modo === 'placa') placa.enviar(quadro);
  else manda('S ' + quadro.toString('hex').toUpperCase());
}

function mandarAjustes() {
  const quadro = aog.steerSettings(ajustesAog);
  if (modo === 'placa') placa.enviar(quadro);
  else manda('S ' + quadro.toString('hex').toUpperCase());
}

function aplicarComando(c) {
  switch (c.acao) {
    // ---- dirigindo ----
    case 'acelerar':     trator.acelerando = !!c.valor; break;
    case 'frear':        trator.freando = !!c.valor; break;
    case 'esqOn':        estercandoEsq = !!c.valor; break;
    case 'dirOn':        estercandoDir = !!c.valor; break;
    case 'marcha':       trator.trocarMarcha(Number(c.valor)); break;
    case 'piloto':       pilotoPedido = !pilotoPedido; break;
    case 'marcarA':      linha.marcarA(trator); break;
    case 'marcarB':      linha.marcarB(trator); break;
    case 'limparRastro': trator.rastro = []; break;
    case 'largura':      linha.largura = Math.max(1, Number(c.valor)); break;

    // ---- AOG ----
    case 'aogLigado':      aogLigado = !!c.valor; break;
    case 'reverseOn':      isReverseOn = !!c.valor; break;
    case 'steerInReverse': isSteerInReverse = !!c.valor; break;
    case 'ajustes':        Object.assign(ajustesAog, c.valor); mandarAjustes(); break;
    case 'config':         Object.assign(configAog, c.valor); mandarConfig(); break;
    // Aplica no AOG o que o GPS mediu. E ACAO DO OPERADOR de proposito: o
    // calibrador mede sozinho o tempo todo, mas mexer no ajuste com o trator
    // andando muda o comportamento do piloto, e isso ninguem faz sem mandar.
    case 'aplicarCalibragem': {
      const r = calibrador.resultado();
      if (!r.pronto) {
        transmitir({ t: 'calibragem', ok: false, motivo: r.motivo });
        break;
      }
      // Motor ao contrario NAO se conserta com numero. O CPD do AOG e sem
      // sinal, entao aplicar a medida aqui esconderia o defeito fisico atras de
      // um ajuste que parece certo — e o trator continuaria fugindo da linha.
      if (r.invertido) {
        transmitir({ t: 'calibragem', ok: false,
                     motivo: 'motor montado ao contrario: isso se conserta na montagem '
                           + 'ou no sentido do firmware, nao no CPD' });
        break;
      }
      const cpdNovo = Math.max(5, Math.min(255, Math.round(r.cpd)));
      // O angulo do firmware e (acumulado - centro + offset)/cpd. Para o zero
      // cair onde o GPS diz que as rodas estao retas, o offset precisa valer a
      // diferenca entre o centro em uso e o centro medido.
      const offsetNovo = Math.round((estadoFirmware.centro || 0) - r.centro);
      const antes = { cpd: ajustesAog.contagensPorGrau, offset: ajustesAog.offsetDirecao };
      ajustesAog.contagensPorGrau = cpdNovo;
      ajustesAog.offsetDirecao = Math.max(-32768, Math.min(32767, offsetNovo));
      if (r.ackerman != null && r.ackerman >= 50 && r.ackerman <= 200) {
        ajustesAog.ackerman = r.ackerman;
      }
      mandarAjustes();
      transmitir({ t: 'calibragem', ok: true, antes,
                   agora: { cpd: cpdNovo, offset: ajustesAog.offsetDirecao,
                            ackerman: ajustesAog.ackerman },
                   laudo: calibrador.laudo(antes.cpd, estadoFirmware.centro) });
      break;
    }

    case 'reiniciarCalibragem': calibrador.reiniciar(); break;
    case 'ruidoGps': ruidoGpsM = Number(c.valor); break;

    case 'wasZero': {
      const atual = (estadoFirmware.anguloAtualX100 || 0) / 100;
      ajustesAog.offsetDirecao += Math.round(ajustesAog.contagensPorGrau * -atual);
      mandarAjustes();
      break;
    }

    // ---- motor ----
    case 'maoNoVolante':     motor.maoNoVolante = !!c.valor; break;
    case 'motorTravado':     motor.travado = !!c.valor; break;
    case 'motorRespondendo': motorRespondendo = !!c.valor; break;
    case 'escorregamento':   motor.escorregamento = Number(c.valor); break;
    case 'folga':            motor.folgaGraus = Math.max(0, Number(c.valor)); break;
    case 'cpdReal':          motor.contagensPorGrauReal = Number(c.valor); break;
    case 'correnteMao':      motor.correnteMao = Number(c.valor); break;
    case 'batente':          motor.batenteGraus = Number(c.valor); break;
    case 'erroMotor':        motor.erro = Number(c.valor); break;
    case 'sentidoMontagem':  motor.sentidoMontagem = Number(c.valor); break;
    case 'pularEncoder':     motor.posicaoMotor += Number(c.valor); break;
    case 'velMotor':         motor.voltasPorSegundoMax = Number(c.valor); break;
    // Trocar a latencia e trocar de experimento, entao o que estava em voo e
    // descartado. Sem isto, baixar o atraso (75 -> 0, que e o que a matriz de
    // Kp faz ao trocar de linha) deixava ~4 snapshots orfaos na fila: o
    // firmware recebia, logo depois de um heartbeat de 75 ms atras, um
    // fresquinho — 75 ms de movimento num passo so. Girando o volante a 32
    // graus/s com CPD 19 sao 45 contagens, acima do teto de 40 do detector de
    // salto, e o modulo perdia a REFERENCIA, que so volta com reboot. A matriz
    // inteira de 08/09 saiu contaminada assim.
    //
    // Esvaziar abre um vao de heartbeat do tamanho do atraso antigo. Isso e
    // seguro: o firmware dimensiona o teto de salto pelo tempo decorrido
    // (limite = 4 + 1800*dt/1000), entao um vao de 75 ms permite 139 contagens,
    // bem acima das 45 que o vao carrega. No maximo ele desengata por
    // "sem heartbeat do motor", que e recuperavel — perder a referencia nao e.
    case 'atrasoMotor':
      atrasoMotorMs = Math.max(0, Number(c.valor));
      filaHeartbeat.length = 0;
      break;

    // ---- placa de verdade ----
    case 'listarPortas':
      listarPortas().then((portas) => transmitir({ t: 'portas', portas }));
      break;
    case 'conectarPlaca':
      placa.conectar(c.valor.caminho, c.valor.baud).then((r) => {
        if (r.ok) {
          modo = 'placa';
          estadoFirmware = { deQuem: 'placa' };   // nada do modo simulado atravessa
          ultimoPgnDaPlaca = Date.now(); placaMuda = false;
          mandarAjustes();
        }
        transmitir({ t: 'placa', ...placaEstado, modo });
      });
      break;
    case 'rodarEspelho':  rodarEspelho(c.valor); break;
    case 'pararEspelho':  espelho.parar(); break;
    case 'reiniciarPlaca':
      textoDaPlaca = [];
      transmitir({ t: 'limparTextoPlaca' });
      placa.reiniciar();
      break;
    case 'desconectarPlaca':
      placa.desconectar().then(() => {
        modo = 'simulado';
        estadoFirmware = {};
        transmitir({ t: 'placa', ...placaEstado, modo });
      });
      break;

    // ---- geral ----
    case 'reset':
      motor.reset(); trator.reset();
      linha.a = linha.b = null;
      pilotoPedido = false;
      estercandoEsq = estercandoDir = false;
      // as chaves tambem voltam ao padrao — senao um teste anterior contamina
      // o proximo sem ninguem perceber
      aogLigado = true; motorRespondendo = true;
      isReverseOn = true; isSteerInReverse = false;
      ajustesAog = { ganhoP: 40, pwmAlto: 180, pwmBaixo: 30, pwmMinimo: 25,
                     contagensPorGrau: 19, offsetDirecao: 0, ackerman: 100 };
      configAog = { set0: 56, maxPulse: 0, minSpeedKmh: 0, set1: 0 };
      contadores = { pgn253: 0, canCmd: 0 };
      ultimoPgn253 = null;
      filaHeartbeat.length = 0;   // nada em voo atravessa um reinicio
      // O calibrador tambem recomeca. Ele nao fazia isso, e as medidas de arco
      // de um roteiro entravam na conta do seguinte — com outro CPD, outra
      // velocidade de motor, outra folga. O ajuste da reta ficava misturando
      // duas maquinas diferentes e devolvia um CPD que nao era de nenhuma das
      // duas (medido: 29 onde a verdade era 19, com R2 caindo para 0,50).
      calibrador.reiniciar();
      manda('R');
      mandarAjustesQuandoSubir();
      break;

    // Acao desconhecida nao pode sumir calada.
    //
    // Um teste mandava 'reiniciar' onde o nome e 'reset'; o comando caia aqui
    // sem erro nenhum e o teste seguia como se tivesse reiniciado — passando por
    // motivo errado por semanas. Comando que nao existe agora aparece no log e
    // volta para quem mandou.
    default:
      console.error('[servidor] acao desconhecida: ' + JSON.stringify(c.acao));
      transmitir({ t: 'acaoDesconhecida', acao: c.acao });
      break;
  }
}

iniciarFirmware();
mandarAjustesQuandoSubir();
servidor.listen(PORTA, () => {
  console.log('\n  Simulador de traducao do autosteer');
  console.log('  firmware: ' + path.relative(process.cwd(), EXE));
  console.log('  abra:     http://localhost:' + PORTA + '\n');
});
