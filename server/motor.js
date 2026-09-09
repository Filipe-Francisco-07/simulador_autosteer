// Modelo do motor Keya + coluna de direcao.
//
// O que importa aqui e a diferenca entre DUAS coisas que o firmware nao
// consegue distinguir sozinho:
//
//   posicao do MOTOR  -> e o que o encoder conta (e o que o firmware ve)
//   angulo das RODAS  -> e o que realmente acontece no trator
//
// Num mundo perfeito os dois andam juntos. No trator real existe o orbitrol
// (a valvula hidraulica da direcao) no meio: se ele escorrega, o motor gira e
// as rodas nao acompanham na mesma proporcao. O encoder continua contando,
// o firmware acha que esterçou, e a roda esta em outro lugar.
//
// E exatamente essa divergencia que decide se o projeto precisa de um sensor
// WAS na barra de direcao (item 2.4 do chamado). Por isso ela e um controle
// do simulador, nao um detalhe escondido.

const KEYA_ID_HB = 0x07000000 | 1;   // motor -> modulo, a cada 20 ms

class MotorKeya {
  constructor() { this.reset(); }

  reset() {
    this.posicaoMotor = 0;      // contagens acumuladas (o que o encoder conta)
    this.anguloRodasGraus = 0;  // onde as rodas REALMENTE estao
    this.velocidadeAtual = 0;   // -1000..1000, como o Keya reporta
    this.comandoVel = 0;        // ultimo comando recebido
    this.habilitado = false;
    this.erro = 0;              // bit0 = desabilitado/falha

    // ---- parametros que o operador do simulador controla ----
    // Quanto o encoder anda por grau de RODA. Nao e escolha de projeto: e a
    // maquina. Pedro mediu no JD 5078 em 05/09 que o fim de curso fica a ~760
    // contagens do centro; com ~40 graus de roda ate la, sao ~19 contagens por
    // grau. Estava 100 aqui (o padrao de tela do AOG), o que fazia o motor
    // simulado precisar de 5x mais contagens do que o real para o mesmo angulo
    // — e enchia o firmware de "salto de encoder" a cada esterçada na mao.
    this.contagensPorGrauReal = 19;
    // Como o motor esta montado no volante. O firmware tem a sua propria
    // constante SENTIDO; se as duas discordarem, a malha diverge em vez de
    // convergir — foi o que aconteceu na bancada em 29/08. Deixar isso como
    // controle (e nao fixo) permite reproduzir aquele bug de proposito.
    this.sentidoMontagem = -1;
    this.escorregamento = 0;          // 0..1 — quanto o orbitrol perde
    this.correnteLivre = 1.0;         // corrente girando solto
    this.correnteMao = 11.0;          // corrente com a mao no volante
    this.maoNoVolante = false;
    this.batenteGraus = 40;           // fim de curso mecanico
    this.travado = false;             // motor fisicamente travado
    this.noBatente = false;           // encostou no fim de curso neste ciclo
    // Velocidade do motor a pleno. NAO E MEDIDA — ver nota em passo().
    // 4 voltas/s dao 1440 contagens/s; com o CPD real (~19) isso sao ~76 graus
    // de roda por segundo, ou seja batente a batente em pouco mais de um
    // segundo. E RAPIDO — com CPD 100 a mesma conta dava 14 graus/s e o
    // simulador parecia muito mais manso do que a maquina e. Quem for confiar
    // em sintonia de Kp tirada daqui precisa cronometrar o motor de verdade
    // batente a batente antes; ver docs/07-calibragem-por-gps.md.
    this.voltasPorSegundoMax = 4;
  }

  // Um comando CAN chegou do firmware.
  receberComando(id, hex) {
    const d = Buffer.from(hex, 'hex');
    if (d.length < 4) return;
    // Enable / Disable: 23 0D 20 01 / 23 0C 20 01
    if (d[0] === 0x23 && d[1] === 0x0D && d[2] === 0x20 && d[3] === 0x01) { this.habilitado = true;  return; }
    if (d[0] === 0x23 && d[1] === 0x0C && d[2] === 0x20 && d[3] === 0x01) { this.habilitado = false; return; }
    // Velocidade: 23 00 20 01 | palavra baixa (BE) | palavra alta (BE)
    if (d[0] === 0x23 && d[1] === 0x00 && d[2] === 0x20 && d[3] === 0x01) {
      const baixa = (d[4] << 8) | d[5];
      const alta  = (d[6] << 8) | d[7];
      // O `|` do JavaScript ja devolve int32 COM SINAL — nao converter de novo,
      // senao -704 vira -4294968000 e o motor sai voando para o batente.
      const v = ((alta << 16) | baixa) | 0;
      this.comandoVel = Math.max(-1000, Math.min(1000, v));
    }
  }

  // Avanca a fisica em `ms` milissegundos.
  passo(ms) {
    // A mao no volante e CARGA, nao so uma leitura de corrente diferente.
    //
    // Antes ela nao freava nada: o motor continuava girando a roda no mesmo
    // ritmo e so o amperimetro mudava. Isso fazia o cenario de override passar
    // por acidente enquanto a planta era lenta (CPD 100, PWM sempre alto) e
    // falhar assim que ela ficou rapida — em nenhum dos dois casos o que estava
    // sendo medido era um override.
    //
    // Um braco humano segura a coluna de direcao contra um motor de autosteer;
    // e essa a premissa do proprio recurso de override. Entao com a mao no
    // volante o motor quase para: sobra so o que ele consegue arrastar.
    // ATENCAO — 0,12 e CHUTE, nao medida. Ninguem cronometrou um braco contra
    // este motor. O que o numero muda e a RAPIDEZ com que o override dispara,
    // nao SE ele dispara: qualquer valor baixo deixa o motor mandado e parado,
    // que e o que levanta a corrente. Medir isso e o item "limiar do override
    // sob carga" que a documentacao do AgroPreciso marca como bloqueante.
    const RESISTENCIA_MAO = 0.12;   // fracao da velocidade que ele ainda vence
    const teto = this.maoNoVolante ? RESISTENCIA_MAO : 1;
    const alvo = (this.habilitado && !this.travado) ? this.comandoVel * teto : 0;
    // resposta do motor: chega perto do comando em ~100 ms
    this.velocidadeAtual += (alvo - this.velocidadeAtual) * Math.min(1, ms / 100);
    if (Math.abs(this.velocidadeAtual) < 1) this.velocidadeAtual = 0;

    // Quanto o motor anda a plena velocidade.
    // ATENCAO — este numero e ESTIMADO, nao medido: o comando do Keya e "por
    // mil da velocidade nominal", e a nominal do KY173 nao foi aferida por nos.
    // 100 rpm (1,67 volta/s) e o chute para motor de coluna de direcao.
    // Aferir com o console do motor antes de confiar na sintonia de Kp que sair
    // daqui; se o motor real for mais rapido, o ganho bom sera menor.
    const voltasPorSegundo = this.voltasPorSegundoMax * (this.velocidadeAtual / 1000);
    const contagensPorMs = voltasPorSegundo * 360 / 1000;
    let deltaContagens = contagensPorMs * ms;

    const deltaGrausRoda = this.sentidoMontagem
                         * (deltaContagens / this.contagensPorGrauReal)
                         * (1 - this.escorregamento);
    const novoAngulo = this.anguloRodasGraus + deltaGrausRoda;

    // No fim de curso o motor NAO continua girando solto: ele esta preso a
    // coluna de direcao, entao trava junto e a corrente sobe. Deixar o encoder
    // correndo aqui seria mentira — e mentira que esconde justamente o caso em
    // que o operador mais precisa confiar na leitura.
    this.noBatente = false;
    if (novoAngulo > this.batenteGraus) {
      this.noBatente = true;
      // so deixa andar o que falta ate o batente
      const sobra = this.batenteGraus - this.anguloRodasGraus;
      deltaContagens *= (deltaGrausRoda !== 0) ? (sobra / deltaGrausRoda) : 0;
      this.anguloRodasGraus = this.batenteGraus;
      this.velocidadeAtual = 0;
    } else if (novoAngulo < -this.batenteGraus) {
      this.noBatente = true;
      const sobra = -this.batenteGraus - this.anguloRodasGraus;
      deltaContagens *= (deltaGrausRoda !== 0) ? (sobra / deltaGrausRoda) : 0;
      this.anguloRodasGraus = -this.batenteGraus;
      this.velocidadeAtual = 0;
    } else {
      this.anguloRodasGraus = novoAngulo;
    }

    // Escorregamento do orbitrol: o motor gira mais do que a roda anda. Aqui o
    // encoder conta o giro do MOTOR — e por isso que ele diverge da roda.
    this.posicaoMotor += deltaContagens;
  }

  correnteAtual() {
    if (!this.habilitado) return 0;
    // Forcando contra o batente puxa corrente igual a uma mao no volante —
    // e por isso que um angulo maximo mal ajustado desengata o piloto sozinho
    // no meio da manobra de cabeceira.
    if (this.travado || this.noBatente) return this.correnteMao * 1.2;
    // O que puxa corrente e o motor sendo MANDADO, nao o motor girando. Um
    // motor travado contra a mao fica parado e puxa o maximo; era ler a
    // velocidade aqui que fazia a mao no volante nao ser sentida quando o
    // modulo estava em cima da linha.
    if (this.comandoVel === 0) return 0;
    if (this.maoNoVolante) return this.correnteMao;
    return this.velocidadeAtual === 0 ? 0 : this.correnteLivre;
  }

  // Monta o heartbeat do jeito que o motor manda (big-endian, 20 ms).
  heartbeat() {
    const b = Buffer.alloc(8);
    const enc = ((Math.round(this.posicaoMotor) % 65536) + 65536) % 65536;
    b.writeUInt16BE(enc, 0);
    b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(this.velocidadeAtual))), 2);
    b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(this.correnteAtual()))), 4);
    const err = this.erro | (this.habilitado ? 0 : 0x0001);
    b.writeUInt16BE(err, 6);
    return { id: KEYA_ID_HB, hex: b.toString('hex').toUpperCase() };
  }

  // O operador girando o volante na mao. O motor esta preso a coluna, entao o
  // encoder acompanha — e por isso que dar meia volta no volante com o piloto
  // desligado tambem mexe na conta do firmware.
  girarManual(deltaGraus) {
    const antes = this.anguloRodasGraus;
    this.anguloRodasGraus = Math.max(-this.batenteGraus,
                            Math.min(this.batenteGraus, antes + deltaGraus));
    const andou = this.anguloRodasGraus - antes;
    const perda = (1 - this.escorregamento) || 1;
    this.posicaoMotor += (andou * this.contagensPorGrauReal / perda) / this.sentidoMontagem;
  }

  // O que o firmware DEVERIA estar estimando, se nada escorregasse.
  anguloRodasX100() { return Math.round(this.anguloRodasGraus * 100); }
}

module.exports = { MotorKeya, KEYA_ID_HB };
