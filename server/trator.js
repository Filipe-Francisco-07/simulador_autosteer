// O trator: onde ele está, para onde aponta e como responde ao volante.
//
// Modelo de bicicleta (o mesmo que o AgOpenGPS usa para a geometria dele):
// as duas rodas de um eixo viram uma só no centro. Para guiagem isso basta —
// o que importa é como o ângulo das rodas vira mudança de rumo.
//
//     drumo/dt = (velocidade / entre-eixos) * tan(ângulo das rodas)
//
// Convenção: rumo 0 = norte, cresce no sentido horário (como bússola).
// x = leste (metros), y = norte (metros).

const GRAU = Math.PI / 180;

// Marchas de um trator pequeno. Cada uma limita a velocidade — é isso que
// impede o operador de sair a 20 km/h numa operação de plantio.
const MARCHAS = [
  { nome: 'R2', max: -8 },
  { nome: 'R1', max: -4 },
  { nome: 'N',  max: 0 },
  { nome: '1',  max: 3 },
  { nome: '2',  max: 5 },
  { nome: '3',  max: 8 },
  { nome: '4',  max: 12 },
  { nome: '5',  max: 18 },
  { nome: '6',  max: 25 },
];
const NEUTRO = 2;

class Trator {
  constructor() {
    this.entreEixos = 2.1;      // metros — JD 5078 fica perto disso
    this.reset();
  }

  reset() {
    this.x = 0; this.y = 0;
    this.rumo = 0;              // radianos, 0 = norte
    this.velocidade = 0;        // km/h, negativo = ré
    this.marcha = NEUTRO;
    this.acelerando = false;
    this.freando = false;
    this.rastro = [];
    this.anguloRodas = 0;       // graus — quem manda aqui é o motor Keya
    this.percorrido = 0;
    this.trocandoSentido = false;
  }

  get nomeMarcha() { return MARCHAS[this.marcha].nome; }
  get velocidadeMaxima() { return MARCHAS[this.marcha].max; }

  trocarMarcha(passo) {
    const nova = this.marcha + passo;
    if (nova < 0 || nova >= MARCHAS.length) return;
    this.marcha = nova;
    // Trocar de sentido com o trator andando: em vez de recusar a marcha (o
    // operador aperta e nao acontece nada, sem entender por que), segura o
    // trator ate ele parar. Foi assim que o simulador ficou preso em re: a
    // marcha de frente era recusada silenciosamente enquanto ele deslizava.
    const inverteu = Math.sign(MARCHAS[nova].max) * Math.sign(this.velocidade) < 0;
    if (inverteu) this.trocandoSentido = true;
  }

  passo(ms) {
    const dt = ms / 1000;
    const alvo = this.velocidadeMaxima;

    // Depois de inverter a marcha o trator para primeiro, dai anda para o
    // outro lado — como quem pisa no freio antes de sair de re.
    if (this.trocandoSentido) {
      if (Math.sign(alvo) * Math.sign(this.velocidade) >= 0 || this.velocidade === 0) {
        this.trocandoSentido = false;
      } else {
        this.velocidade -= Math.sign(this.velocidade) * Math.min(Math.abs(this.velocidade), 10 * dt);
        if (Math.abs(this.velocidade) < 0.05) { this.velocidade = 0; this.trocandoSentido = false; }
      }
    }

    if (this.freando) {
      this.velocidade -= Math.sign(this.velocidade) * Math.min(Math.abs(this.velocidade), 14 * dt);
    } else if (this.acelerando && alvo !== 0) {
      // acelera até o teto da marcha
      const passo = (alvo > 0 ? 4 : -4) * dt;
      this.velocidade += passo;
      if ((alvo > 0 && this.velocidade > alvo) || (alvo < 0 && this.velocidade < alvo)) {
        this.velocidade = alvo;
      }
    } else {
      // solto: perde velocidade sozinho (motor segurando + atrito)
      this.velocidade -= Math.sign(this.velocidade) * Math.min(Math.abs(this.velocidade), 2.2 * dt);
    }
    if (Math.abs(this.velocidade) < 0.02) this.velocidade = 0;

    const vms = this.velocidade / 3.6;          // km/h -> m/s
    this.rumo += (vms / this.entreEixos) * Math.tan(this.anguloRodas * GRAU) * dt;
    this.rumo = ((this.rumo % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    this.x += vms * Math.sin(this.rumo) * dt;
    this.y += vms * Math.cos(this.rumo) * dt;
    this.percorrido += Math.abs(vms) * dt;

    // rastro para a tela (um ponto a cada meio metro, para não pesar)
    const ultimo = this.rastro[this.rastro.length - 1];
    if (!ultimo || Math.hypot(this.x - ultimo.x, this.y - ultimo.y) > 0.5) {
      this.rastro.push({ x: this.x, y: this.y, re: this.velocidade < 0 });
      if (this.rastro.length > 3000) this.rastro.shift();
    }
  }

  // Rumo que um GPS mede: a direção do DESLOCAMENTO. Andando de ré, ele aponta
  // para trás do trator — e é daí que nasce a confusão do AgOpenGPS na ré.
  rumoDoGps() {
    return this.velocidade < 0 ? (this.rumo + Math.PI) % (2 * Math.PI) : this.rumo;
  }
}

// ---------------------------------------------------------------------------
// A linha AB e a guiagem: é o papel do AgOpenGPS, reproduzido aqui para fechar
// a malha. Ele mede o quanto o trator está fora da linha e pede um ângulo.
// ---------------------------------------------------------------------------
class LinhaAB {
  constructor() {
    this.a = null; this.b = null; this.rumoLinha = 0;
    // Largura de trabalho: e ela que define as paralelas. No AgOpenGPS este
    // numero e a largura do implemento menos a sobreposicao
    // (`tool.width - tool.overlap`, CABLine.cs:107) e o padrao de fabrica e 4 m.
    this.largura = 4;
  }

  marcarA(t) { this.a = { x: t.x, y: t.y }; this.b = null; }

  marcarB(t) {
    if (!this.a) return;
    this.b = { x: t.x, y: t.y };
    this.rumoLinha = Math.atan2(this.b.x - this.a.x, this.b.y - this.a.y);
  }

  get pronta() { return !!(this.a && this.b); }

  // Distância com sinal até a linha (positivo = trator à direita dela).
  erroLateral(t) {
    if (!this.pronta) return 0;
    const dx = t.x - this.a.x, dy = t.y - this.a.y;
    return dx * Math.cos(this.rumoLinha) - dy * Math.sin(this.rumoLinha);
  }

  // Lei de guiagem no estilo Stanley: soma o erro de RUMO (o trator esta
  // torto em relacao a linha?) com uma correcao pelo erro LATERAL (esta longe
  // dela?). Escolhido em vez do pure pursuit puro porque continua se
  // comportando quando o trator esta muito fora e apontando para longe — no
  // pure pursuit essa situacao inverte o sinal e o trator foge da linha.
  anguloDesejado(t, mira, entreEixos, velocidade) {
    if (!this.pronta) return 0;

    let erroRumo = this.rumoLinha - t.rumo;
    while (erroRumo > Math.PI) erroRumo -= 2 * Math.PI;
    while (erroRumo < -Math.PI) erroRumo += 2 * Math.PI;

    // Passada vizinha: guiar sempre para a linha central deixaria o trator
    // atravessando o campo. O AOG segue a paralela mais proxima, de 3 em 3 m.
    const xte = this.erroLateralNaPassada(t);

    const v = Math.max(1, Math.abs(velocidade || 0));
    const correcaoLateral = Math.atan2(-1.2 * xte, v);
    const angulo = (erroRumo + correcaoLateral) / GRAU;
    return Math.max(-40, Math.min(40, angulo));
  }

  // Distancia ate a passada mais proxima.
  //
  // O AgOpenGPS guia pela paralela mais perto, nao pela linha AB original: ele
  // calcula quantas passadas de distancia o trator esta (`howManyPathsAway`,
  // CABLine.cs:126-129) e segue aquela. E por isso que engatar longe da AB
  // prende o trator na vizinha — e o certo, senao ele atravessaria o campo
  // para voltar a linha de referencia.
  erroLateralNaPassada(t) {
    const bruto = this.erroLateral(t);
    const passadas = Math.round(bruto / this.largura);
    return bruto - passadas * this.largura;
  }

  // Qual passada o trator esta seguindo (0 = a linha AB original).
  passadaAtual(t) {
    if (!this.pronta) return 0;
    return Math.round(this.erroLateral(t) / this.largura);
  }
}

module.exports = { Trator, LinhaAB, MARCHAS, NEUTRO };
