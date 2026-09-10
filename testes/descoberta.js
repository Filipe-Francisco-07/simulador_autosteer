// O módulo responde ao "quem está aí"? É por esse quadro que o AgIO decide se
// mostra ou some com o módulo na tela.
//
// Este roteiro existe porque o simulador NAO estava exercitando esse caminho:
// o hello que ele montava tinha 11 bytes onde o firmware espera 9, e desde a
// validacao de quadro de 07/09 ele era descartado em silencio. Um teste que
// manda quadro invalido nao testa o modulo, testa o descarte.
//
// Roda direto contra o firmware, sem servidor:
//   node testes/descoberta.js

const { spawnSync } = require('child_process');
const path = require('path');
const aog = require('../server/aog.js');

const EXE = path.join(__dirname, '..', 'sim', 'firmware_sim.exe');

// Resposta de descoberta: 80 81 | 126 (fonte) | 126 (PGN) | 5 (tamanho)
const RESPOSTA = '80817E7E05';

function perguntar(quadro) {
  const entrada = ['T 50', 'S ' + quadro.toString('hex').toUpperCase(), 'T 50', 'T 50'].join('\n') + '\n';
  const r = spawnSync(EXE, [], { input: entrada, encoding: 'utf8' });
  const saidas = r.stdout.split('\n')
    .filter((l) => l.includes('"serial_tx"'))
    .map((l) => { try { return JSON.parse(l).hex; } catch { return ''; } });
  return saidas.find((h) => h.startsWith(RESPOSTA)) || null;
}

function quadroTorto(mudar) {
  const b = Buffer.from(aog.hello());
  mudar(b);
  return b;
}

const casos = [
  {
    nome: 'hello correto de 9 bytes',
    quadro: aog.hello(),
    esperaResposta: true,
    porque: 'o quadro bem formado tem que ser respondido',
  },
  {
    nome: 'hello legado do AgIO 6.8.5',
    quadro: aog.helloLegado(),
    esperaResposta: true,
    porque: 'o AgIO nao recalcula a soma; recusar faz o modulo sumir da tela',
  },
  {
    nome: 'hello com 11 bytes (o que o simulador mandava)',
    quadro: Buffer.concat([aog.hello().subarray(0, 8), Buffer.from([0, 0, 0])]),
    esperaResposta: false,
    porque: 'tamanho errado: e assim que o quadro sumia sem ninguem ver',
  },
  {
    nome: 'hello com CRC errado (e nao o legado)',
    quadro: quadroTorto((b) => { b[8] = (b[8] + 1) & 0xFF; }),
    esperaResposta: false,
    porque: 'a excecao do CRC vale SO para o quadro legado exato, mais nada',
  },
  {
    nome: 'hello com fonte errada',
    quadro: quadroTorto((b) => { b[2] = 0x7E; b[8] = aog.crc(b); }),
    esperaResposta: false,
    porque: 'quadro do proprio modulo nao pode ser lido como pergunta do PC',
  },
];

let ok = 0, ruim = 0;
console.log('\n  DESCOBERTA — o modulo aparece no AgIO?\n');
for (const c of casos) {
  const resposta = perguntar(c.quadro);
  const acertou = (resposta !== null) === c.esperaResposta;
  acertou ? ok++ : ruim++;
  console.log(`  [${acertou ? ' ok ' : 'FALHA'}] ${c.nome}`);
  console.log(`          ${c.esperaResposta ? 'devia responder' : 'devia ignorar'} · ` +
              `${resposta ? 'respondeu ' + resposta.slice(0, 22) : 'calado'}`);
  console.log(`          ${c.porque}`);
}
console.log(`\n  ${ok} ok, ${ruim} falharam\n`);
process.exit(ruim ? 1 : 0);
