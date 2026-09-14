// Descobre o esterçamento REAL pelo GPS, sem sensor de angulo nas rodas.
//
// O PROBLEMA
// Nao ha WAS (wheel angle sensor). O modulo estima o angulo contando pulsos do
// encoder do motor:  angulo = (contagens - centro) / CPD.  Os tres numeros
// dessa conta hoje sao chutados:
//   - CPD    (contagens por grau): digitado na tela do AOG no olho;
//   - centro: gravado no boot, supondo que as rodas estavam retas;
//   - sentido: se o motor foi montado ao contrario, tudo inverte e NADA avisa.
// Errar qualquer um deles nao da erro na tela: da um trator que sai da linha.
//
// A SAIDA
// O trator ja e um sensor de angulo, so que indireto. Pelo modelo da bicicleta
// (o mesmo que o simulador usa para andar):
//
//     curvatura do caminho = tan(angulo) / entre_eixos
//
// Entao, medindo o quanto o caminho ENVERGA, sai o angulo verdadeiro das rodas:
//
//     angulo_real = atan( entre_eixos * curvatura )
//
// Comparando com as contagens do encoder no mesmo trecho, uma reta resolve os
// tres numeros de uma vez. Nao e chute: e medida, e sai de um passeio na lavoura.
//
// DUAS ARMADILHAS QUE CUSTARAM O PRIMEIRO ANDAR DESTE ARQUIVO
//
// 1) NAO DA PARA TIRAR CURVATURA DE DUAS POSICOES SEGUIDAS.
//    A 6 km/h o AOG entrega uma posicao a cada 16 cm. Com RTK de 2 cm, o rumo
//    derivado de duas delas tem ~10 graus de ruido, e a taxa de giro derivada
//    disso tem mais ruido que sinal. A primeira versao deste arquivo fazia
//    exatamente isso e devolvia CPD 0,2 onde a verdade era 19.
//    O jeito certo e ajustar um ARCO a uma janela de ~1 s de posicoes: o erro
//    de cada ponto se cancela em vez de ser derivado.
//
// 2) O LADO RUIDOSO TEM QUE FICAR NA RESPOSTA, NAO NO REGRESSOR.
//    Ajustar "contagens em funcao do angulo" parece natural, mas o angulo e o
//    lado ruidoso: ruido no regressor puxa a inclinacao para zero (diluicao de
//    regressao) e o CPD sai menor do que e. As contagens do encoder sao quase
//    limpas, entao a reta certa e "angulo em funcao das contagens", e o CPD e
//    o INVERSO da inclinacao.
//
// O QUE ELE NAO RESOLVE
// So vale com o trator andando e esterçando. Sem curva nao ha curvatura para
// medir, e parado a conta nao existe. Precisa de curva para os dois lados, e o
// angulo precisa ficar mais ou menos parado durante cada janela — por isso o
// procedimento de campo e "vira, SEGURA alguns segundos, vira mais", nao
// ziguezague continuo.

const GRAU = Math.PI / 180;

// Diferenca de rumo tratando a volta no circulo (359 para 1 e +2, nao -358).
function difAngulo(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Curvatura de um trecho de caminho, com sinal (positivo = virando para a
// direita, seguindo a convencao de rumo do simulador: 0 = norte, cresce no
// sentido horario).
//
// Os pontos sao girados para o referencial da corda (primeiro ao ultimo) e uma
// parabola y = a + b*s + c*s^2 e ajustada. Para arcos curtos isso e mais estavel
// que ajustar um circulo: o ajuste de circulo classico enviesa quando o arco e
// pequeno, que e exatamente o nosso caso.
function curvaturaDoTrecho(pontos) {
  const n = pontos.length;
  if (n < 5) return null;
  const p0 = pontos[0], pf = pontos[n - 1];
  const dx = pf.x - p0.x, dy = pf.y - p0.y;
  const corda = Math.hypot(dx, dy);
  if (corda < 0.5) return null;                 // trecho curto demais para medir
  const cos = dx / corda, sin = dy / corda;

  // s ao longo da corda, h perpendicular a ela
  let sw = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, h0 = 0, h1 = 0, h2 = 0;
  for (const p of pontos) {
    const ex = p.x - p0.x, ey = p.y - p0.y;
    const s = ex * cos + ey * sin;
    const h = -ex * sin + ey * cos;
    sw += 1; s1 += s; s2 += s * s; s3 += s * s * s; s4 += s * s * s * s;
    h0 += h; h1 += h * s; h2 += h * s * s;
  }
  // sistema normal 3x3 para [a, b, c]
  const m = [[sw, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const v = [h0, h1, h2];
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 1e-12) return null;
  // regra de Cramer so para o coeficiente c, que e o unico que interessa
  const mc = [[m[0][0], m[0][1], v[0]], [m[1][0], m[1][1], v[1]], [m[2][0], m[2][1], v[2]]];
  const detC = mc[0][0] * (mc[1][1] * mc[2][2] - mc[1][2] * mc[2][1])
             - mc[0][1] * (mc[1][0] * mc[2][2] - mc[1][2] * mc[2][0])
             + mc[0][2] * (mc[1][0] * mc[2][1] - mc[1][1] * mc[2][0]);
  const c = detC / det;
  const mb = [[m[0][0], v[0], m[0][2]], [m[1][0], v[1], m[1][2]], [m[2][0], v[2], m[2][2]]];
  const detB = mb[0][0] * (mb[1][1] * mb[2][2] - mb[1][2] * mb[2][1])
             - mb[0][1] * (mb[1][0] * mb[2][2] - mb[1][2] * mb[2][0])
             + mb[0][2] * (mb[1][0] * mb[2][1] - mb[1][1] * mb[2][0]);
  const b = detB / det;
  // curvatura de y(s) no meio do trecho; o sinal segue o eixo h, que aponta
  // para a ESQUERDA da corda, entao invertemos para "positivo = direita"
  const k = 2 * c / Math.pow(1 + b * b, 1.5);
  return { curvatura: -k, corda };
}

class CalibradorPorGps {
  // entreEixos em metros.
  // janelaMs: quanto de caminho entra em cada medida de curvatura. Maior reduz
  //   o ruido e borra a variacao do angulo; 1200 ms e o meio termo para o
  //   procedimento "vira e segura".
  // velocidadeMinimaKmh: abaixo disso o trecho nao rende curvatura confiavel.
  constructor({ entreEixos = 2.1, velocidadeMinimaKmh = 1.5,
                janelaMs = 1200, maxMedidas = 4000 } = {}) {
    this.entreEixos = entreEixos;
    this.velocidadeMinimaKmh = velocidadeMinimaKmh;
    this.janelaMs = janelaMs;
    this.maxMedidas = maxMedidas;
    this.pontos = [];
    this.medidas = [];
  }

  reiniciar() { this.pontos = []; this.medidas = []; }

  // Uma posicao do GPS, do jeito que ela chega no trator de verdade:
  //   t              ms
  //   x, y           metros no plano local (o AOG ja trabalha assim)
  //   velocidadeKmh  COM SINAL: negativo de re
  //   contagens      o acumulado do encoder que o modulo esta usando
  observarPosicao({ t, x, y, velocidadeKmh, contagens }) {
    this.pontos.push({ t, x, y, velocidadeKmh, contagens });
    // mantem so a janela corrente
    while (this.pontos.length > 2 && t - this.pontos[0].t > this.janelaMs) this.pontos.shift();
    const jan = this.pontos;
    if (jan.length < 6) return null;
    if (t - jan[0].t < this.janelaMs * 0.8) return null;

    // Velocidade e sentido tem que ser estaveis dentro da janela: uma janela que
    // pega a troca de marcha mistura dois mundos e inventa uma curva.
    let vMin = Infinity, vMax = -Infinity;
    for (const p of jan) { vMin = Math.min(vMin, p.velocidadeKmh); vMax = Math.max(vMax, p.velocidadeKmh); }
    if (vMin * vMax <= 0) return null;                       // trocou de sentido
    if (Math.abs(vMin) < this.velocidadeMinimaKmh) return null;

    const arco = curvaturaDoTrecho(jan);
    if (!arco) return null;

    // Andando de re o caminho enverga para o lado contrario ao do volante:
    // o sinal da curvatura precisa ser desfeito para voltar ao referencial do
    // volante, que e o que o encoder mede.
    const paraTras = vMin < 0;
    const curvatura = paraTras ? -arco.curvatura : arco.curvatura;

    const anguloReal = Math.atan(this.entreEixos * curvatura) / GRAU;
    if (Math.abs(anguloReal) > 60) return null;              // impossivel: e ruido

    // contagens no MEIO da janela, que e onde a curvatura foi avaliada
    const meio = jan[Math.floor(jan.length / 2)];
    const m = {
      t, anguloReal, contagens: meio.contagens,
      peso: arco.corda,        // trecho mais longo, curvatura mais confiavel
    };
    this.medidas.push(m);
    while (this.medidas.length > this.maxMedidas) this.medidas.shift();
    return m;
  }

  // Reta angulo = a + b * contagens, por minimos quadrados pesados.
  //
  // O angulo e o lado RUIDOSO e por isso fica na resposta: ruido na resposta
  // nao enviesa a inclinacao, ruido no regressor enviesa. Dai CPD = 1/b.
  static _reta(medidas) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const m of medidas) {
      const w = m.peso;
      sw += w; sx += w * m.contagens; sy += w * m.anguloReal;
      sxx += w * m.contagens * m.contagens; sxy += w * m.contagens * m.anguloReal;
    }
    if (sw === 0) return null;
    const den = sw * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return null;      // encoder nao saiu do lugar
    const b = (sw * sxy - sx * sy) / den;       // graus por contagem
    const a = (sy - b * sx) / sw;
    if (b === 0) return null;
    let ssTot = 0, ssRes = 0;
    const media = sy / sw;
    for (const m of medidas) {
      const prev = a + b * m.contagens;
      ssRes += m.peso * (m.anguloReal - prev) ** 2;
      ssTot += m.peso * (m.anguloReal - media) ** 2;
    }
    return {
      grausPorContagem: b,
      cpd: 1 / b,                               // com sinal: negativo = invertido
      centro: -a / b,                           // contagens onde o angulo e zero
      r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
      n: medidas.length,
    };
  }

  // O resultado da calibragem. Devolve "nao pronto" enquanto nao houver passeio
  // que preste: dizer "ainda nao sei" e melhor que devolver numero inventado.
  resultado() {
    const a = this.medidas;
    if (a.length < 60) return { pronto: false, motivo: 'poucas amostras andando', n: a.length };

    const angs = a.map((s) => s.anguloReal);
    const espalhamento = Math.max(...angs) - Math.min(...angs);
    if (espalhamento < 8) {
      return { pronto: false, motivo: 'faltou curva — precisa esterçar para os dois lados',
               espalhamento, n: a.length };
    }
    // Sem variacao de encoder nao ha reta: o volante ficou parado e o que mudou
    // foi so o ruido.
    const cnts = a.map((s) => s.contagens);
    const faixaContagens = Math.max(...cnts) - Math.min(...cnts);
    if (faixaContagens < 50) {
      return { pronto: false, motivo: 'o encoder quase nao saiu do lugar', faixaContagens, n: a.length };
    }

    const geral = CalibradorPorGps._reta(a);
    if (!geral) return { pronto: false, motivo: 'nao deu para ajustar a reta', n: a.length };

    const esq = a.filter((s) => s.anguloReal < -2);
    const dir = a.filter((s) => s.anguloReal > 2);
    // Ackerman: a mesma contagem rende angulos diferentes para cada lado.
    // O AOG guarda isso como percentual do lado esquerdo sobre o direito.
    const rEsq = esq.length > 20 ? CalibradorPorGps._reta(esq) : null;
    const rDir = dir.length > 20 ? CalibradorPorGps._reta(dir) : null;
    const ackerman = rEsq && rDir && rDir.cpd !== 0
      ? Math.round(100 * Math.abs(rEsq.cpd / rDir.cpd)) : null;

    // Escorregamento do orbitrol: se o centro medido no comeco do passeio nao
    // for o mesmo do fim, contagens foram embora sem virar angulo.
    const meio = Math.floor(a.length / 2);
    const p1 = CalibradorPorGps._reta(a.slice(0, meio));
    const p2 = CalibradorPorGps._reta(a.slice(meio));
    const minutos = (a[a.length - 1].t - a[0].t) / 60000;
    const derivaPorMinuto = p1 && p2 && minutos > 0.05
      ? (p2.centro - p1.centro) / minutos : null;

    return {
      pronto: true,
      // |CPD| porque o AOG so aceita positivo; o sinal vira o aviso de montagem.
      cpd: Math.abs(geral.cpd),
      centro: geral.centro,
      invertido: geral.cpd < 0,
      ackerman,
      r2: geral.r2,
      derivaPorMinuto,
      espalhamento,
      faixaContagens,
      n: a.length,
      amostrasEsquerda: esq.length,
      amostrasDireita: dir.length,
    };
  }

  // O mesmo resultado em portugues, para quem esta no trator com o celular.
  laudo(cpdConfigurado, centroConfigurado) {
    const r = this.resultado();
    if (!r.pronto) return ['Ainda nao da para dizer: ' + r.motivo];
    const l = [];
    l.push(`CPD medido pelo GPS: ${r.cpd.toFixed(1)} contagens por grau` +
           (cpdConfigurado != null ? ` (configurado: ${cpdConfigurado})` : ''));
    if (cpdConfigurado != null && cpdConfigurado > 0) {
      const razao = r.cpd / cpdConfigurado;
      if (razao > 1.15 || razao < 0.87) {
        l.push(`  ATENCAO: o configurado esta ${razao.toFixed(2)}x fora. ` +
               `O angulo na tela sai ${(1 / razao).toFixed(2)}x do real.`);
      }
    }
    if (r.invertido) {
      l.push('  ATENCAO: o motor esta montado AO CONTRARIO — o encoder cresce ' +
             'para o lado errado. Engatar assim faz o trator fugir da linha.');
    }
    l.push(`Centro medido: ${r.centro.toFixed(0)} contagens` +
           (centroConfigurado != null ? ` (em uso: ${centroConfigurado})` : ''));
    if (centroConfigurado != null) {
      const erroGraus = (centroConfigurado - r.centro) / (r.cpd || 1);
      if (Math.abs(erroGraus) > 1) {
        l.push(`  o zero de partida pegou as rodas ${Math.abs(erroGraus).toFixed(1)} graus ` +
               `para a ${erroGraus > 0 ? 'direita' : 'esquerda'}, nao retas.`);
      }
    }
    if (r.ackerman != null) l.push(`Ackerman medido: ${r.ackerman}%`);
    if (r.derivaPorMinuto != null && Math.abs(r.derivaPorMinuto) > 1) {
      l.push(`Escorregamento do orbitrol: ${r.derivaPorMinuto.toFixed(1)} contagens por minuto ` +
             `(${(r.derivaPorMinuto / (r.cpd || 1)).toFixed(2)} grau por minuto de zero perdido)`);
    }
    l.push(`Confianca: R2=${r.r2.toFixed(3)} · ${r.n} medidas de arco · ` +
           `${r.espalhamento.toFixed(0)} graus de curva usados`);
    if (r.r2 < 0.8) l.push('  R2 baixo: passeio curto, ruim de GPS ou orbitrol escorregando muito.');
    return l;
  }
}

module.exports = { CalibradorPorGps, curvaturaDoTrecho, difAngulo };
