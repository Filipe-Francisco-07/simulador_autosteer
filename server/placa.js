// Conversa com o ESP32 de verdade, pela USB.
//
// No modo simulado o firmware roda como processo aqui no PC e a gente enxerga
// tudo por dentro. Com a placa na mao e diferente: ela e uma caixa fechada.
// So da para ver o que ela RESPONDE — e e exatamente por isso que vale a pena,
// porque agora entram na conta a serial de verdade, o baud, o buffer e o
// tempo real do ESP32.
//
// LIMITE IMPORTANTE: a placa fala com o motor Keya por CAN, num barramento
// fisico que o PC nao ve. Sem o motor ligado nela, o firmware nunca recebe
// heartbeat: o angulo fica em zero e o piloto nao esterca. Nesse arranjo o que
// se testa e a camada AgOpenGPS <-> modulo, nao a malha inteira.

const { SerialPort } = require('serialport');
const aog = require('./aog.js');

const BAUD_PADRAO = 38400;   // o firmware fixa isso (BAUD_PGN no main.cpp)

// PGNs que so existem no firmware de bancada:
//   240 = o PC injeta um heartbeat do Keya (fingindo ser o motor)
//   241 = a placa ecoa o comando CAN que mandou ao motor
const PGN_INJETAR_CAN = 0xF0;
const PGN_ECO_CAN = 0xF1;

const SEPARADOR_LINHA = /\r?\n/;
// Caractere de substituicao do UTF-8 ou byte de controle: marca de que o que
// chegou nao era texto.
const RUIDO_BINARIO = new RegExp('[' + '\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F' + ']');

// O ESP32 do modulo usa CH340 (o mesmo par VID/PID que aparece nos dois
// modulos do AgroPreciso, sem numero de serie).
const VID_CH340 = '1a86';
const PID_CH340 = '7523';

async function listarPortas() {
  const portas = await SerialPort.list();
  return portas.map((p) => ({
    caminho: p.path,
    nome: p.friendlyName || p.manufacturer || '',
    vid: (p.vendorId || '').toLowerCase(),
    pid: (p.productId || '').toLowerCase(),
    provavel: (p.vendorId || '').toLowerCase() === VID_CH340
           && (p.productId || '').toLowerCase() === PID_CH340,
  }));
}

class Placa {
  constructor({ aoReceberPgn, aoTexto, aoEstado, aoComandoCan }) {
    this.aoComandoCan = aoComandoCan || (() => {});
    this.porta = null;
    this.caminho = null;
    this.baud = BAUD_PADRAO;
    this.aoReceberPgn = aoReceberPgn;
    this.aoTexto = aoTexto;       // o banner e qualquer texto solto
    this.aoEstado = aoEstado;     // 'ligando' | 'ligada' | 'desligada' | 'erro'
    this.buffer = Buffer.alloc(0);
    this.linhaParcial = '';
    this.ultimoErro = null;
    // vira true quando a placa ecoa um comando CAN — so o firmware de bancada faz isso
    this.temBancada = false;
  }

  get ligada() { return !!(this.porta && this.porta.isOpen); }

  async conectar(caminho, baud) {
    await this.desconectar();
    this.caminho = caminho;
    this.baud = baud || BAUD_PADRAO;
    this.ultimoErro = null;
    this.aoEstado('ligando');

    return new Promise((resolve) => {
      this.porta = new SerialPort({ path: this.caminho, baudRate: this.baud, autoOpen: false });

      this.porta.on('data', (d) => this.receber(d));
      this.porta.on('error', (e) => {
        this.ultimoErro = e.message;
        this.aoEstado('erro', e.message);
      });
      this.porta.on('close', () => this.aoEstado('desligada'));

      this.porta.open((err) => {
        if (err) {
          this.ultimoErro = err.message;
          this.aoEstado('erro', err.message);
          this.porta = null;
          resolve({ ok: false, erro: err.message });
          return;
        }
        this.aoEstado('ligada');
        // Reinicia o ESP32 ao conectar. Duas razoes: o teste comeca com o
        // firmware do zero, e o banner (que so sai no boot) diz QUAL firmware
        // esta gravado, com data de compilacao. Sem isso a pergunta "esta
        // atualizado?" so tem resposta regravando.
        this.reiniciar();
        resolve({ ok: true });
      });
    });
  }

  // Pulso de DTR/RTS: a mesma sequencia que o esptool usa para dar boot.
  reiniciar() {
    if (!this.ligada) return;
    this.porta.set({ dtr: false, rts: true }, () => {
      setTimeout(() => { if (this.ligada) this.porta.set({ dtr: false, rts: false }, () => {}); }, 120);
    });
  }

  async desconectar() {
    if (!this.porta) return;
    const p = this.porta;
    this.porta = null;
    await new Promise((r) => p.close(() => r()));
  }

  // Separa PGN do texto solto. O firmware imprime um banner antes de entregar
  // a porta ao AOG; sem separar, esse texto entraria no meio dos quadros.
  receber(pedaco) {
    this.buffer = Buffer.concat([this.buffer, pedaco]);

    while (this.buffer.length >= 2) {
      const inicio = this.buffer.indexOf(Buffer.from([0x80, 0x81]));

      if (inicio === -1) {
        // nao ha quadro a vista: o que sobrou e texto (menos os ultimos bytes,
        // que podem ser o comeco de um cabecalho partido pela metade)
        if (this.buffer.length > 1) {
          this.emitirTexto(this.buffer.subarray(0, this.buffer.length - 1));
          this.buffer = this.buffer.subarray(this.buffer.length - 1);
        }
        return;
      }
      if (inicio > 0) {
        this.emitirTexto(this.buffer.subarray(0, inicio));
        this.buffer = this.buffer.subarray(inicio);
      }
      if (this.buffer.length < 5) return;             // falta o cabecalho
      const total = 5 + this.buffer[4] + 1;
      if (this.buffer.length < total) return;         // quadro ainda chegando

      const quadro = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      // O eco do comando CAN e do firmware de bancada: entrega o que o motor
      // receberia, sem o PC precisar deduzir pelo modulo do PWM.
      if (quadro[3] === PGN_ECO_CAN && quadro.length >= 14) {
        this.temBancada = true;
        this.aoComandoCan(quadro.subarray(5, 13));
      } else {
        this.aoReceberPgn(quadro);
      }
    }
  }

  emitirTexto(bytes) {
    // Junta com o que sobrou: um quadro PGN no meio da frase nao pode partir
    // a linha do banner em duas.
    this.linhaParcial += bytes.toString('utf8');

    const partes = this.linhaParcial.split(SEPARADOR_LINHA);
    this.linhaParcial = partes.pop();          // o resto fica para a proxima
    for (const linha of partes) this.talvezEmitir(linha);

    // uma linha sem fim de linha nao pode ficar presa para sempre
    if (this.linhaParcial.length > 200) {
      this.talvezEmitir(this.linhaParcial);
      this.linhaParcial = '';
    }
  }

  talvezEmitir(linha) {
    const t = linha.trim();
    if (t.length < 3) return;

    // Ao reiniciar, o ESP32 cospe o log da ROM de boot em 74880 baud. Lido a
    // 38400 isso vira bytes aleatorios, e decodificar bytes aleatorios como
    // UTF-8 deixa marca: caractere de substituicao e bytes de controle. E o
    // jeito confiavel de separar o ruido do banner de verdade, que e texto.
    if (RUIDO_BINARIO.test(t)) return;

    this.aoTexto(t);
  }

  enviar(quadro) {
    if (!this.ligada) return false;
    this.porta.write(quadro);
    return true;
  }

  // Manda o heartbeat do Keya para a placa, como se viesse do motor.
  // So o firmware de bancada entende; o de producao ignora (PGN desconhecido).
  injetarHeartbeat(hex) {
    if (!this.ligada) return false;
    const b = Buffer.alloc(14);
    b[0] = 0x80; b[1] = 0x81; b[2] = 0x7F; b[3] = PGN_INJETAR_CAN; b[4] = 8;
    Buffer.from(hex, 'hex').copy(b, 5);
    let soma = 0;
    for (let i = 2; i < 13; i++) soma += b[i];
    b[13] = soma & 0xFF;
    this.porta.write(b);
    return true;
  }
}

module.exports = { Placa, listarPortas, BAUD_PADRAO, PGN_INJETAR_CAN, PGN_ECO_CAN };
