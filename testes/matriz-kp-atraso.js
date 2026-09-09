// Quanto atraso a malha aguenta, para cada ganho?
//
// A pergunta nasceu da bancada: com a placa no meio, o heartbeat e o comando
// atravessam a USB duas vezes (~25 ms, com picos de 50) e o trator passou a
// oscilar. Antes de culpar o firmware, vale medir a fronteira — e o numero
// serve para o campo: diz quanta folga o Kp escolhido deixa.
const { Piloto } = require('./piloto.js');

// A faixa desceu em 07/09. Ate entao esta matriz rodava com CPD 100, que era o
// padrao de tela do AOG e nao a maquina: com o CPD real (~19, do batente medido
// no JD 5078) o mesmo PWM move a roda 5,3x mais rapido em graus por segundo.
// Planta mais rapida desestabiliza com ganho MENOR, entao a fronteira que
// interessa esta abaixo do que se media antes — e os numeros publicados com
// CPD 100 nao valem para o trator.
const GANHOS = [5, 10, 20, 40, 80];
// Os atrasos param em 30 ms de proposito, e o motivo NAO e o laco de controle.
//
// Medido em 09/09 (6 engates para cada atraso): ate 30 ms engata 6/6; em 40 ms
// cai para 1/6 e em 75 ms para 0/6. Quem derruba e o guarda de "motor em erro"
// do firmware, que conta 4 heartbeats seguidos com o motor se dizendo
// DESABILITADO enquanto o modulo comanda PWM. No engate, os primeiros
// heartbeats a chegar sao anteriores ao ENABLE e contam; com o transporte
// atrasando perto de 4 periodos (~96 ms), o modulo desengata sozinho sem
// defeito nenhum embaixo.
//
// Ou seja: acima de ~30 ms nao da para medir ganho, porque nao ha engate para
// medir — e a celula nao diz nada sobre o Kp. A tolerancia a atraso do conjunto
// e fixada por esse guarda, nao pelo controle.
const ATRASOS = [0, 15, 30];
const CPD = 19;

(async () => {
  const p = new Piloto();
  await p.pronto;
  await p.usarSimulado();

  console.log('erro medio nos ultimos 10 s de cada combinacao (metros)\n');
  process.stdout.write('  Kp \ atraso ');
  for (const a of ATRASOS) process.stdout.write(String(a + ' ms').padStart(9));
  console.log('\n  ' + '-'.repeat(12 + ATRASOS.length * 9));

  for (const kp of GANHOS) {
    process.stdout.write('  ' + String(kp).padStart(10) + '  ');
    for (const atraso of ATRASOS) {
      await p.zerar();
      p.envia('ajustes', { ganhoP: kp, contagensPorGrau: CPD, pwmMinimo: 25, pwmAlto: 180 });
      p.envia('atrasoMotor', atraso);
      await p.espera(400);
      await p.prepararLinha();
      p.engatar();
      await p.espera(15000);

      const amostras = [];
      let ciclosSolto = 0;
      for (let i = 0; i < 8; i++) {
        await p.espera(500);
        const a = p.amostra();
        if (!a) continue;
        if (!a.piloto) ciclosSolto++;
        amostras.push(Math.abs(a.xte));
      }
      p.parar();
      // Piloto solto NAO e "nao estabiliza": e celula sem medida nenhuma.
      // Sem esta checagem o teste devolvia ~1,00 m para uma combinacao que
      // sequer chegou a engatar, e isso se le como "esse Kp e ruim" — conclusao
      // inventada. Em 08/09 a matriz inteira saiu assim e quase virou
      // recomendacao de campo.
      if (ciclosSolto > amostras.length / 2) {
        process.stdout.write('  solto'.padStart(9));
        continue;
      }
      const media = amostras.reduce((s, v) => s + v, 0) / (amostras.length || 1);
      const marca = media < 0.2 ? ' ' : media < 0.5 ? '~' : '!';
      process.stdout.write((media.toFixed(2) + marca).padStart(9));
    }
    console.log('');
  }
  console.log('\n  espaco = firme (< 20 cm)   ~ = oscila pouco   ! = nao estabiliza');
  p.fechar();
  process.exit(0);
})();
