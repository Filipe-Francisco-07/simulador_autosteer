// Um tradutor de mentira, para testar a aba do AgOpenGPS sem placa nenhuma.
//
// POR QUE ISSO EXISTE
// Testar a janela de configuração exigia um ESP32 numa porta COM. Só que o AgIO
// fala com os módulos por DOIS caminhos, e o de UDP não precisa de hardware:
//
//   ReceiveFromLoopBack() no AgIO faz SendUDPMessage(data, epModule) ANTES do
//   switch de PGN, ou seja manda TUDO que vem do AgOpenGPS para 255.255.255.255
//   na porta 8888. E fica escutando resposta na porta 9999.
//
// Então este programa faz o papel do módulo: escuta a 8888, responde na 9999.
// O AgIO acha que é um módulo de autosteer em rede e repassa para o AOG.
//
// Ele imita o firmware de verdade no que importa para a aba:
//   - manda PGN 253 a cada 100 ms, que é o que acende o módulo no AgOpenGPS
//   - responde ao PGN 240 com assinatura AP01 devolvendo o PGN 239
//   - guarda os ajustes que chegam por PGN 252, 251 e pelo serviço op2
//   - imita a flash: flashPendente fica ligado um tempinho antes de assentar
//
// Uso:
//   node config-tradutor/modulo-falso.js
//
// Depois abra o AgIO e o AgOpenGPS e vá em Wizards, Config. do tradutor.

const dgram = require('dgram');

// --mudo: manda o PGN 253 normalmente, mas nunca responde ao PGN 240. E o
// caso de um firmware velho, ou do AgIO sem o roteamento do 240. Serve para
// ver a mensagem que a aba mostra nessa situacao, que e diferente da de
// "sem modulo nenhum".
const MUDO = process.argv.includes('--mudo');

const PORTA_ESCUTA = 8888;   // o AgIO manda para cá
const PORTA_AGIO = 9999;     // o AgIO escuta aqui
const FONTE_MODULO = 0x7E;   // 126

// Estado que o módulo carrega, igual ao registro APS2 da NVS.
const modulo = {
  cpd: 100,
  ackerman: 100,
  limiar: 5,
  limiteEsquerdo: 700,
  limiteDireito: 700,
  velocidadeMinima: 0,
  ganhoP: 40,
  anguloX100: 0,
  pwm: 0,
  encoder: 0,
  saltos: 0,
  referencia: true,
  ligado: false,
  trava: false,
  heartbeatFresco: true,
  falha: 0,
  flashPendente: false,
};

let gravaEm = 0;             // quando a flash assenta
const nascimento = Date.now();

const soma = (q) => {
  let s = 0;
  for (let i = 2; i < q.length - 1; i++) s += q[i];
  return s & 0xFF;
};

// ---------------------------------------------------------------- quadros

// PGN 253: o que o módulo manda sozinho. É o que faz o AgOpenGPS considerar
// que existe um módulo de autosteer no ar.
function quadro253() {
  const q = Buffer.alloc(14);
  q[0] = 0x80; q[1] = 0x81; q[2] = FONTE_MODULO; q[3] = 0xFD; q[4] = 8;
  q.writeInt16LE(modulo.anguloX100, 5);
  q.writeUInt16LE(9999, 7);          // sem rumo
  q.writeInt16LE(8888, 9);           // sem rolagem
  q[11] = 0x02;                      // chaves
  // byte 12: acionando manda o PWM; parado manda o código da falha
  q[12] = modulo.pwm ? Math.min(255, Math.abs(modulo.pwm)) : modulo.falha;
  q[13] = soma(q);
  return q;
}

// PGN 239 com assinatura AP01: a resposta ao pedido de configuração.
function quadroAP01(op, resultado, marca) {
  const q = Buffer.alloc(38);
  q[0] = 0x80; q[1] = 0x81; q[2] = FONTE_MODULO; q[3] = 239; q[4] = 32;
  q.write('AP01', 5, 'ascii');
  q[9] = op;
  q[10] = resultado;
  q[11] = (modulo.referencia ? 1 : 0) | (modulo.ligado ? 2 : 0) | (modulo.trava ? 4 : 0)
        | (modulo.heartbeatFresco ? 8 : 0)
        | ((modulo.limiteEsquerdo >= 500 && modulo.limiteDireito >= 500) ? 16 : 0);
  q[12] = modulo.falha;
  q[13] = modulo.cpd; q[14] = modulo.ackerman; q[15] = modulo.limiar;
  q.writeInt16LE(modulo.anguloX100, 16);
  q.writeInt16LE(modulo.pwm, 18);
  q.writeUInt16LE(modulo.limiteEsquerdo, 20);
  q.writeUInt16LE(modulo.limiteDireito, 22);
  q.writeInt32LE(modulo.encoder, 24);
  q.writeUInt32LE(Date.now() - nascimento, 28);
  q.writeUInt16LE(modulo.saltos, 32);
  q[34] = modulo.flashPendente ? 1 : 0;
  q[35] = 0;                         // sem erro de flash
  q[36] = marca;
  q[37] = soma(q);
  return q;
}

// ---------------------------------------------------------------- recepção

const soquete = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let destino = null;                  // de onde o AgIO fala, para responder nele

function responder(quadro) {
  const ip = destino || '127.0.0.1';
  soquete.send(quadro, PORTA_AGIO, ip);
}

function tratar(q) {
  if (q.length < 6 || q[0] !== 0x80 || q[1] !== 0x81) return;
  const pgn = q[3];

  // ---- ajustes: CPD, Ackerman, ganho ----
  if (pgn === 0xFC && q.length >= 14) {
    modulo.ganhoP = q[5];
    modulo.cpd = q[9];
    modulo.ackerman = q[12];
    marcarGravacao('PGN 252: CPD=' + modulo.cpd + ' ackerman=' + modulo.ackerman
                   + ' kp=' + modulo.ganhoP);
    return;
  }

  // ---- configuração: corrente de desligamento e velocidade mínima ----
  if (pgn === 0xFB && q.length >= 14) {
    const set1 = q[8];
    const temSensorDeCarga = (set1 & 0x06) !== 0;
    // Mesma regra do firmware: sem sensor marcado, maxPulse é contagem de
    // pulso de encoder e NÃO vira limiar de corrente.
    if (temSensorDeCarga && q[6] > 0 && q[6] <= 100) modulo.limiar = q[6];
    modulo.velocidadeMinima = q[7];
    marcarGravacao('PGN 251: limiar=' + modulo.limiar + 'A velMin=' + modulo.velocidadeMinima
                   + (temSensorDeCarga ? '' : ' (sem sensor de carga, limiar ignorado)'));
    return;
  }

  // ---- serviço: só com a assinatura AP01, igual ao firmware ----
  if (pgn === 240 && q.length === 16 && q.toString('ascii', 5, 9) === 'AP01') {
    const op = q[9];
    const marca = q[14];
    let resultado = 0;

    if (op === 2) {
      const esq = q.readUInt16LE(10);
      const dir = q.readUInt16LE(12);
      if (esq < 500 || esq > 6000 || dir < 500 || dir > 6000) {
        resultado = 1;
        console.log('  op2 RECUSADA: limites fora de 5 a 60 graus');
      } else {
        modulo.limiteEsquerdo = esq;
        modulo.limiteDireito = dir;
        marcarGravacao('op2: esterço ' + esq / 100 + ' / ' + dir / 100 + ' graus');
      }
    } else if (op !== 0 && op !== 1 && op !== 3) {
      resultado = 2;
    }

    if (MUDO) {
      console.log('  PGN 240 op' + op + ' recebido, mas estou --mudo: nao respondo');
      return;
    }

    responder(quadroAP01(op, resultado, marca));
    return;
  }
}

// A flash do ESP32 junta as mudanças antes de escrever. Imitar isso importa:
// é o que a aba espera cair antes de dizer "gravado".
function marcarGravacao(oQue) {
  console.log('  ' + oQue);
  modulo.flashPendente = true;
  gravaEm = Date.now() + 600;
}

setInterval(() => {
  if (modulo.flashPendente && Date.now() >= gravaEm) {
    modulo.flashPendente = false;
    console.log('  flash assentou');
  }
}, 100);

// ---------------------------------------------------------------- ligação

soquete.on('message', (msg, quem) => {
  destino = quem.address;
  // pode vir mais de um quadro no mesmo pacote
  let i = 0;
  while (i + 5 <= msg.length) {
    if (msg[i] !== 0x80 || msg[i + 1] !== 0x81) { i++; continue; }
    const total = msg[i + 4] + 6;
    if (i + total > msg.length) break;
    tratar(msg.subarray(i, i + total));
    i += total;
  }
});

soquete.on('listening', () => {
  soquete.setBroadcast(true);
  console.log('\n  Tradutor de mentira no ar.');
  console.log('  escutando  UDP ' + PORTA_ESCUTA + '   (o AgIO manda para cá)');
  console.log('  respondendo UDP ' + PORTA_AGIO + '   (o AgIO escuta aqui)');
  console.log('\n  Abra o AgIO e o AgOpenGPS, depois Wizards > Config. do tradutor.\n');
  if (MUDO) console.log('  MODO MUDO: recebo o PGN 240 mas nao devolvo o 239\n');
  console.log('  estado inicial: CPD ' + modulo.cpd + ', ackerman ' + modulo.ackerman
              + ', limiar ' + modulo.limiar + 'A, esterço '
              + modulo.limiteEsquerdo / 100 + '/' + modulo.limiteDireito / 100 + ' graus\n');
});

soquete.bind(PORTA_ESCUTA);

// o módulo de verdade manda o 253 a cada 100 ms
setInterval(() => responder(quadro253()), 100);
