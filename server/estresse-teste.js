// Estresse do firmware REAL, sem interface — os cenarios da lista "vale a pena
// tentar quebrar" do README que fazem sentido no nivel do main.cpp (nao do
// trator/AOG simulado). Fala com o mesmo sim/firmware_sim.exe do malha-teste.js.
//
// NAO substitui pio test (logica pura, na placa) nem o AogFake (protocolo, na
// placa) — roda sem ESP32 porque exercita o comportamento de SISTEMA (watchdog
// de tempo, integracao com a corrente do motor simulado) que os testes de
// logica pura nao alcancam sozinhos.
//
//   node server/estresse-teste.js

const { spawn } = require('child_process');
const path = require('path');
const { MotorKeya } = require('./motor.js');
const aog = require('./aog.js');

const EXE = path.join(__dirname, '..', 'sim', 'firmware_sim.exe');
const AJUSTES_PADRAO = { ganhoP: 40, pwmAlto: 180, pwmBaixo: 30, pwmMinimo: 25,
                          contagensPorGrau: 19, offsetDirecao: 0, ackerman: 100 };

class Driver {
  constructor() {
    this.fw = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.motor = new MotorKeya();
    this.estado = {};
    this.quadrosPgn253 = 0;
    this.quadrosCrcRuim = 0;
    let buffer = '';
    this.fw.stdout.on('data', (c) => {
      buffer += c.toString();
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const linha = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!linha) continue;
        let m; try { m = JSON.parse(linha); } catch { continue; }
        if (m.t === 'can_tx') this.motor.receberComando(m.id, m.hex);
        else if (m.t === 'state') this.estado = m;
        else if (m.t === 'serial_tx') {
          const f = aog.parseFromAutoSteer(Buffer.from(m.hex, 'hex'));
          if (f) { this.quadrosPgn253++; if (!f.crcOk) this.quadrosCrcRuim++; }
        }
      }
    });
  }

  manda(l) { this.fw.stdin.write(l + '\n'); }
  espera(ms) { return new Promise((r) => setTimeout(r, ms)); }

  ajustar(a) { this.manda('S ' + aog.steerSettings(a).toString('hex').toUpperCase()); }

  // Um passo de 20 ms. `enviarS`/`enviarC` desligados simulam corte de cabo / CAN.
  async tique({ comando, enviarS = true, enviarC = true } = {}) {
    this.manda('T 20');
    this.motor.passo(20);
    if (enviarC) {
      const hb = this.motor.heartbeat();
      this.manda('C ' + hb.id + ' ' + hb.hex);
    }
    if (enviarS && comando) this.manda('S ' + aog.steerData(comando).toString('hex').toUpperCase());
    this.manda('Q');
    await this.espera(1);
  }

  // Leva o modulo do boot ate "pronto para engatar", como o AgIO faz.
  //
  // O firmware de 07/09 nao nasce mais pronto: ele precisa de um ZERO DE
  // PARTIDA, e para centrar exige piloto DESLIGADO, velocidade ZERO, heartbeat
  // fresco e PGN recente ao mesmo tempo. Depois disso a trava de seguranca
  // ainda pede 250 ms de piloto desligado para soltar.
  //
  // Este roteiro mandava `engatar: true` com velocidade 5 desde o primeiro
  // tique, entao o modulo nunca centrava e os 6 cenarios falhavam todos com
  // `engatou=false` — sem defeito nenhum embaixo.
  async partir(ajustes = AJUSTES_PADRAO) {
    this.ajustar(ajustes);
    const parado = { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 };
    for (let i = 0; i < 40; i++) await this.tique({ comando: parado });   // 800 ms
    return this.estado.referencia === true && this.estado.travaSeguranca === false;
  }

  fim() { this.fw.stdin.end(); }
}

const resultados = [];
function registrar(nome, ok, detalhe) {
  resultados.push({ nome, ok, detalhe });
  console.log((ok ? 'OK   ' : 'FALHA') + ' ' + nome.padEnd(42) + ' ' + detalhe);
}

// ---------------------------------------------------------------------------
// A. Corte de cabo do AOG com o piloto engatado — o cao de guarda de PGN e
//    hoje AOG_MAX_MS = 500 ms (era 1000 ate 06/09).
// ---------------------------------------------------------------------------
async function testeCorteCabo() {
  const d = new Driver();
  await d.espera(300);
  await d.partir();
  const comando = { velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 10, xte: 0 };

  for (let i = 0; i < 50; i++) await d.tique({ comando });          // 1 s pra engatar e assentar
  const engatouAntes = d.estado.autosteerLigado === true;
  const tCorte = d.estado.ms;

  let tDesengatou = null;
  for (let i = 0; i < 90 && tDesengatou === null; i++) {            // ate 1,8 s sem S
    await d.tique({ comando, enviarS: false });
    if (d.estado.autosteerLigado === false) tDesengatou = d.estado.ms;
  }
  const pwmZerouTambem = d.estado.pwmSaida === 0;
  d.fim();

  const atraso = tDesengatou !== null ? tDesengatou - tCorte : null;
  // A janela virou AOG_MAX_MS = 500 ms no firmware de 07/09 (era 1000).
  const ok = engatouAntes && atraso !== null && atraso >= 450 && atraso <= 700 && pwmZerouTambem;
  registrar('corte do cabo AOG (piloto engatado)', ok,
    `engatou=${engatouAntes} desengatou em ${atraso}ms apos o corte (esperado ~500ms) pwm=0:${pwmZerouTambem}`);
}

// ---------------------------------------------------------------------------
// B. Corte do CAN (motor some) com o piloto engatado — segundo cao de guarda:
//    hoje `if (viuHb && !hbFresco(agora)) parar(CanAusente)`, com
//    HB_MAX_MS = 200 ms. Era 1000 ms ate 06/09.
// ---------------------------------------------------------------------------
async function testeCorteCan() {
  const d = new Driver();
  await d.espera(300);
  await d.partir();
  const comando = { velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 10, xte: 0 };

  for (let i = 0; i < 50; i++) await d.tique({ comando });
  const engatouAntes = d.estado.autosteerLigado === true;
  const keyaVistoAntes = d.estado.keyaVisto === true;
  const tCorte = d.estado.ms;

  let tDesengatou = null;
  for (let i = 0; i < 90 && tDesengatou === null; i++) {
    await d.tique({ comando, enviarC: false });                    // motor sumiu do barramento
    if (d.estado.autosteerLigado === false) tDesengatou = d.estado.ms;
  }
  d.fim();

  const atraso = tDesengatou !== null ? tDesengatou - tCorte : null;
  // HB_MAX_MS = 200 ms no firmware de 07/09 (era 1000).
  const ok = engatouAntes && keyaVistoAntes && atraso !== null && atraso >= 180 && atraso <= 400;
  registrar('corte do CAN (motor some, piloto engatado)', ok,
    `engatou=${engatouAntes} keyaVisto=${keyaVistoAntes} desengatou em ${atraso}ms apos o corte (esperado ~200ms)`);
}

// ---------------------------------------------------------------------------
// C. Mao no volante: precisa (1) desengatar sozinho, (2) FICAR solto enquanto
//    o AOG insiste em pedir engate — a trava so cai com o pedido solto — e
//    (3) reengatar quando o operador soltar por 250 ms e pedir de novo.
// ---------------------------------------------------------------------------
async function testeMaoNoVolante() {
  const d = new Driver();
  await d.espera(300);
  await d.partir();
  const comando = { velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 15, xte: 0 };

  for (let i = 0; i < 30; i++) await d.tique({ comando });
  const engatouAntes = d.estado.autosteerLigado === true;

  d.motor.maoNoVolante = true;
  let ciclosAteDesengatar = null;
  for (let i = 0; i < 30 && ciclosAteDesengatar === null; i++) {
    await d.tique({ comando });
    if (d.estado.autosteerLigado === false) ciclosAteDesengatar = i + 1;
  }

  // continua pedindo engate por 2s — tem que continuar solto (nao so 1 ciclo)
  let voltouSozinho = false;
  for (let i = 0; i < 100; i++) {
    await d.tique({ comando });
    if (d.estado.autosteerLigado === true) { voltouSozinho = true; break; }
  }

  // solta o volante mas SEM soltar o pedido — trava so cai na borda de descida
  d.motor.maoNoVolante = false;
  let reengatouSemBorda = false;
  for (let i = 0; i < 30; i++) {
    await d.tique({ comando });
    if (d.estado.autosteerLigado === true) { reengatouSemBorda = true; break; }
  }

  // agora sim: o operador solta o pedido e pede de novo.
  //
  // Ate 06/09 bastava UM ciclo com engatar:false — a trava caia na borda de
  // descida, na hora. Desde 07/09 sao 250 ms de pedido solto E o modulo
  // saudavel. Este teste soltava por 20 ms e concluia que nao reengatava.
  const soltando = { ...comando, engatar: false };
  for (let i = 0; i < 20; i++) await d.tique({ comando: soltando });   // 400 ms
  let reengatouComBorda = false;
  for (let i = 0; i < 30; i++) {
    await d.tique({ comando });
    if (d.estado.autosteerLigado === true) { reengatouComBorda = true; break; }
  }
  d.fim();

  // EMA_ALFA=0.10 precisa de ~6 ciclos so pra correnteMedia cruzar o limiar de
  // 5.0 partindo de ~1.0, e so DEPOIS entram os 4 ciclos de CICLOS_DESENGATE —
  // ~9-10 ciclos (180-200ms) e o tempo real de resposta, nao um bug.
  const ok = engatouAntes && ciclosAteDesengatar !== null && ciclosAteDesengatar <= 15
             && !voltouSozinho && !reengatouSemBorda && reengatouComBorda;
  registrar('mao no volante: desengata, fica solto, so reengata apos soltar o pedido', ok,
    `desengatou em ${ciclosAteDesengatar} ciclos de 20ms (~${ciclosAteDesengatar * 20}ms, EMA+debounce) · voltou sozinho=${voltouSozinho} ` +
    `· reengatou sem soltar pedido=${reengatouSemBorda} · reengatou apos soltar pedido=${reengatouComBorda}`);
}

// ---------------------------------------------------------------------------
// D. Pedir angulo alem do envelope — o CONTRATO MUDOU em 07/09.
//
// Antes: a roda ia ate o ferro, a corrente subia igual a mao no volante e a
// protecao de sobrecorrente desengatava. Era protecao por acidente.
//
// Agora o firmware tem um envelope proprio, derivado do batente medido
// (BATENTE_CONTAGENS = 700) e do CPD vigente. Chegando nele, ele SEGURA o
// angulo e CONTINUA ENGATADO — o PWM daquele sentido vai a zero. Quem desengata
// passou a ser so a sobrecorrente de verdade, ou seja forcar contra o ferro.
//
// Entao o que se exige aqui inverteu: pedir 80 graus NAO pode levar a roda ao
// batente fisico, e NAO pode desengatar. Se a roda encostar no ferro, o
// envelope falhou.
// ---------------------------------------------------------------------------
async function testeAlemDoBatente() {
  const d = new Driver();
  await d.espera(300);
  await d.partir();
  const comando = { velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 80, xte: 0 }; // batente fisico: 40 graus

  let encostouNoFerro = false;
  let desengatou = false, motivo = null, quandoMs = null, anguloAoCair = null;
  // So vale como desengate depois de ter engatado. Sem esta guarda os primeiros
  // ciclos — em que o pedido acabou de chegar e o modulo ainda nao ligou — eram
  // contados como queda, e o cenario acusava um defeito que nao existe.
  let jaEngatou = false;
  for (let i = 0; i < 250; i++) {                                  // 5s
    await d.tique({ comando });
    if (d.motor.noBatente) encostouNoFerro = true;
    if (d.estado.autosteerLigado === true) jaEngatou = true;
    if (jaEngatou && d.estado.autosteerLigado === false && !desengatou) {
      desengatou = true;
      motivo = d.estado.falhaNome;
      quandoMs = d.estado.ms;
      anguloAoCair = d.estado.anguloAtualX100 / 100;
    }
  }
  const anguloFinal = d.motor.anguloRodasGraus;
  const limiteGraus = (d.estado.limiteDireito || 0) / 100;
  d.fim();

  // Parou dentro do envelope, com folga para o ferro, e sem largar o piloto.
  const parouNoEnvelope = Math.abs(anguloFinal) <= limiteGraus + 1;
  const ok = jaEngatou && !encostouNoFerro && !desengatou && parouNoEnvelope;
  registrar('pedir alem do envelope: segura o angulo e NAO encosta no ferro', ok,
    `parou em ${anguloFinal.toFixed(1)}° (envelope ${limiteGraus.toFixed(1)}°, ferro 40°)`
    + ` · encostou no ferro=${encostouNoFerro}`
    + (desengatou ? ` · DESENGATOU em ${quandoMs}ms por "${motivo}" com o estimado em ${anguloAoCair.toFixed(1)}°` : ' · seguiu engatado'));
}

// ---------------------------------------------------------------------------
// E. Estouro de 16 bits do encoder enquanto esterca — nao pode dar salto no
//    angulo estimado quando o contador do Keya vira 0xFFFF -> 0x0000.
// ---------------------------------------------------------------------------
async function testeEstouroEncoder() {
  const d = new Driver();
  await d.espera(300);
  // O motor comeca perto do estouro do contador de 16 bits do proprio Keya.
  // Esterçar para +30 graus com o SENTIDO do firmware faz o contador ANDAR PARA
  // TRAS, entao comecar perto do zero e o caminho para o estouro.
  //
  // ISTO PRECISA VIR ANTES DE partir(). Estava depois, e ai o salto de 0 para
  // 200 contagens de uma vez era lido pelo firmware como encoder perdendo
  // conta: ele derrubava a REFERENCIA e o cenario nem chegava a engatar.
  d.motor.posicaoMotor = 200;
  await d.partir();
  const comando = { velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 30, xte: 0 };

  let maiorSaltoX100 = 0;
  let anterior = null;
  let atravessouEstouro = false;
  let encoderBrutoAnterior = null;
  for (let i = 0; i < 150; i++) {                                  // 3s, cruza o 0xFFFF varias vezes
    await d.tique({ comando });
    const brutoAtual = ((Math.round(d.motor.posicaoMotor) % 65536) + 65536) % 65536;
    if (encoderBrutoAnterior !== null && Math.abs(brutoAtual - encoderBrutoAnterior) > 32768) atravessouEstouro = true;
    encoderBrutoAnterior = brutoAtual;

    const atual = d.estado.anguloAtualX100;
    if (typeof atual === 'number') {
      if (typeof anterior === 'number') maiorSaltoX100 = Math.max(maiorSaltoX100, Math.abs(atual - anterior));
      anterior = atual;
    }
  }
  d.fim();

  // um salto legitimo por ciclo de 20ms e pequeno (poucos graus); um bug de
  // estouro mal tratado apareceria como um salto de dezenas de graus.
  const ok = atravessouEstouro && maiorSaltoX100 < 500; // < 5 graus por ciclo de 20ms
  registrar('estouro de 16 bits do encoder durante a guiagem', ok,
    `atravessou o estouro=${atravessouEstouro} maior salto entre ciclos=${(maiorSaltoX100 / 100).toFixed(2)}°`);
}

// ---------------------------------------------------------------------------
// F. Motor montado ao contrario. O encoder fica no EIXO DO MOTOR, entao a
//    contagem que volta pro firmware acompanha o comando que ELE MESMO deu —
//    SENTIDO e aplicado nos dois pontos (main.cpp:61-66) e se cancela dentro
//    do proprio firmware, nao importa como o motor esta montado na coluna.
//    Resultado esperado (e e exatamente o perigo do "SEM WAS" que o README
//    documenta): o firmware ACHA que chegou no alvo — mas a RODA foi para o
//    lado contrario. Nao ha corrente alta pra acusar, porque o firmware para
//    de forcar assim que a leitura (mentirosa) bate com o alvo.
// ---------------------------------------------------------------------------
async function testeMontadoAoContrario() {
  const d = new Driver();
  await d.espera(300);
  await d.partir();
  d.motor.sentidoMontagem = 1; // firmware assume SENTIDO=-1; aqui invertemos so o motor

  const comando = { velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 15, xte: 0 };
  for (let i = 0; i < 150; i++) await d.tique({ comando });          // 3s

  const estimado = (d.estado.anguloAtualX100 || 0) / 100;
  const real = d.motor.anguloRodasGraus;
  const firmwareFoiEnganado = Math.abs(estimado - 15) < 1;   // acha que chegou
  const rodaFoiParaOladoErrado = real < 5;                   // mas a roda nao foi
  d.fim();

  const ok = firmwareFoiEnganado && rodaFoiParaOladoErrado;
  registrar('motor montado ao contrario: firmware nao detecta (esperado, SEM WAS)', ok,
    `estimado=${estimado.toFixed(2)}° (achou q chegou nos 15°) · roda real=${real.toFixed(2)}° · ` +
    `piloto continuou ligado=${d.estado.autosteerLigado} — nada acusa o erro fisico`);
}

(async () => {
  await testeCorteCabo();
  await testeCorteCan();
  await testeMaoNoVolante();
  await testeAlemDoBatente();
  await testeEstouroEncoder();
  await testeMontadoAoContrario();

  const falhas = resultados.filter((r) => !r.ok);
  console.log('\n' + (falhas.length === 0
    ? `todos os ${resultados.length} cenarios passaram`
    : `${falhas.length} de ${resultados.length} cenarios falharam`));
  process.exit(falhas.length === 0 ? 0 : 1);
})();
