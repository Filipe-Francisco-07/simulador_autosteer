// Monta e le os quadros PGN do AgOpenGPS, do lado de quem FINGE ser o AOG.
//
// Formato do quadro:  80 81 <origem> <pgn> <tam> <dados...> <crc>
// CRC = soma dos bytes de [2] ate o penultimo, truncada em 8 bits.
// (Mesma conta do aog_pgn.h do firmware — se um dia divergir, o simulador
//  deixa de conversar, que e o aviso que a gente quer.)

function crc(buf) {
  let soma = 0;
  for (let i = 2; i < buf.length - 1; i++) soma += buf[i];
  return soma & 0xFF;
}

// PGN 254 — o comando de cada ciclo: velocidade, engate e angulo desejado.
function steerData({ velocidadeKmh = 0, engatar = false, anguloAlvoGraus = 0, xte = 0 }) {
  const b = Buffer.alloc(14);
  b[0] = 0x80; b[1] = 0x81; b[2] = 0x7F; b[3] = 0xFE; b[4] = 8;
  b.writeUInt16LE(Math.round(velocidadeKmh * 10), 5);
  b[7] = engatar ? 1 : 0;
  b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(anguloAlvoGraus * 100))), 8);
  b.writeInt8(Math.max(-128, Math.min(127, Math.round(xte))), 10);
  b[11] = 0; b[12] = 0;
  b[13] = crc(b);
  return b;
}

// PGN 252 — os ganhos e a calibracao que vem da tela do AOG.
function steerSettings({ ganhoP = 40, pwmAlto = 180, pwmBaixo = 30, pwmMinimo = 25,
                         contagensPorGrau = 100, offsetDirecao = 0, ackerman = 100 }) {
  const b = Buffer.alloc(14);
  b[0] = 0x80; b[1] = 0x81; b[2] = 0x7F; b[3] = 0xFC; b[4] = 8;
  b[5] = ganhoP & 0xFF; b[6] = pwmAlto & 0xFF; b[7] = pwmBaixo & 0xFF; b[8] = pwmMinimo & 0xFF;
  b[9] = contagensPorGrau & 0xFF;
  b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(offsetDirecao))), 10);
  b[12] = ackerman & 0xFF;
  b[13] = crc(b);
  return b;
}

// PGN 200 — o "quem esta ai" que o AgIO manda para descobrir modulos.
//
// TAMANHO IMPORTA. Desde 07/09 o firmware valida o quadro inteiro:
// `n == dados + 6`, fonte, PGN, o campo de tamanho e o CRC. Com dados = 3 o
// quadro tem 9 bytes, nao 11.
//
// A versao anterior daqui montava 11 bytes e era DESCARTADA em silencio — o
// modulo nunca respondia e o simulador nunca exercitou o caminho de descoberta,
// que e exatamente o que o commit 3d87c18 ("modulo nao some do AgIO") existe
// para consertar. Testar o caminho de descoberta com um quadro que o firmware
// rejeita nao testa nada.
function hello() {
  const b = Buffer.alloc(9);
  b[0] = 0x80; b[1] = 0x81; b[2] = 0x7F; b[3] = 200; b[4] = 3;
  b[5] = 0; b[6] = 0; b[7] = 0;
  b[8] = crc(b);
  return b;
}

// O hello que o AgIO 6.8.5 manda de verdade.
//
// Ele nao recalcula a soma: manda 0x47 fixo, que NAO e o CRC destes bytes. O
// firmware abre uma excecao exata e somente para este quadro (aogHelloValido),
// porque recusa-lo faria o modulo sumir da tela do AgIO. Vale ter os dois aqui:
// o correto e o que o mundo real manda.
function helloLegado() {
  return Buffer.from([0x80, 0x81, 127, 200, 3, 56, 0, 0, 0x47]);
}

// PGN 253 — a resposta do modulo.
//
// ATENCAO: o byte 12 NAO e so o PWM. O firmware faz (main.cpp, no envio do 253):
//
//     const uint8_t diag = controle.pwm ? abs(controle.pwm) : (uint8_t)controle.falha;
//
// Ou seja: ACIONANDO manda o PWM de verdade; PARADO manda o CODIGO DA FALHA.
// Ate 06/09 o valor parado era o CPD em uso; mudou em 07/09 e a tabela abaixo e
// a nova. Quem le sem saber acha que o motor esta acionando com forca 5 quando
// na verdade ele esta parado por sobrecorrente.
//
// Nao da para distinguir os dois pelo numero. Na bancada, o comando CAN ecoado
// diz o PWM de verdade; sem ele, resta o byte como esta.
const FALHAS = [
  'nenhuma',
  'sem zero de partida',
  'salto de encoder',
  'sem heartbeat do motor',
  'sem PGN do AOG',
  'sobrecorrente',
  'motor em erro',
  'transporte CAN',
  'ajuste trocado ou recusado',
  'fora do curso',
  'abaixo da velocidade minima',
];

function nomeDaFalha(codigo) {
  return FALHAS[codigo] || ('codigo ' + codigo);
}

function parseFromAutoSteer(buf) {
  if (buf.length < 14 || buf[0] !== 0x80 || buf[1] !== 0x81 || buf[3] !== 0xFD) return null;
  const diagnostico = buf[12];
  return {
    anguloX100: buf.readInt16LE(5),
    rumoX10:    buf.readUInt16LE(7),
    rolagemX10: buf.readInt16LE(9),
    chaves:     buf[11],
    pwm:        diagnostico,      // pode ser o PWM ou o codigo de falha — ver acima
    diagnostico,
    // So vale como falha se o modulo estiver parado, e isso o 253 sozinho nao
    // diz. Quem sabe e o eco do CAN na bancada; sem ele fica a leitura otimista.
    falhaSeParado: nomeDaFalha(diagnostico),
    crcOk:      buf[13] === crc(buf.subarray(0, 14)),
  };
}

// Le a velocidade do comando do Keya (23 00 20 01 + int32 em duas palavras).
// E o que permite saber o PWM de verdade, com sinal, quando a placa ecoa.
function velocidadeDoComandoKeya(dados) {
  if (!dados || dados.length < 8) return null;
  if (dados[0] !== 0x23 || dados[1] !== 0x00 || dados[2] !== 0x20 || dados[3] !== 0x01) return null;
  const baixa = (dados[4] << 8) | dados[5];
  const alta  = (dados[6] << 8) | dados[7];
  return ((alta << 16) | baixa) | 0;
}

// Separa um fluxo de bytes em quadros completos (o firmware manda colado).
function separarQuadros(bytes) {
  const quadros = [];
  let i = 0;
  while (i + 4 < bytes.length) {
    if (bytes[i] === 0x80 && bytes[i + 1] === 0x81) {
      const total = 5 + bytes[i + 4] + 1;
      if (i + total <= bytes.length) {
        quadros.push(bytes.subarray(i, i + total));
        i += total;
        continue;
      } else break;
    }
    i++;
  }
  return quadros;
}

module.exports = {
  nomeDaFalha, FALHAS, steerData, steerSettings, hello, helloLegado, parseFromAutoSteer, separarQuadros, crc,
                   velocidadeDoComandoKeya };
