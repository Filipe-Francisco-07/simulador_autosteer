// Compila o firmware REAL do modulo de autosteer para rodar no PC.
//
// Nao existe copia do firmware neste repositorio, de proposito: o build aponta
// para o arquivo do repo AgroPreciso. Assim o que voce testa aqui e sempre a
// versao que esta la — se o Pedro mexer no firmware, o proximo build ja pega.
//
// Caminho do firmware: variavel FIRMWARE_SRC, ou o padrao (repos lado a lado).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PADRAO_FIRMWARE = path.resolve(__dirname, '..', 'AgroPreciso', 'AgroPreciso',
                                     'firmware', 'autosteer_can_esp32', 'src');
const FW = path.resolve(process.env.FIRMWARE_SRC || PADRAO_FIRMWARE);

const MAIN = path.join(FW, 'main.cpp');
if (!fs.existsSync(MAIN)) {
  console.error('\nNao achei o firmware em:\n  ' + FW);
  console.error('\nAponte com a variavel FIRMWARE_SRC, por exemplo:');
  console.error('  set FIRMWARE_SRC=C:\\caminho\\autosteer_can_esp32\\src && npm run build\n');
  process.exit(1);
}

// Procura o compilador: zig c++ (portatil) ou g++/clang++ se ja existirem.
function acharCompilador() {
  const candidatos = [
    { cmd: path.join(os.homedir(), 'tools', 'zig-x86_64-windows-0.16.0', 'zig.exe'), args: ['c++'] },
    { cmd: 'zig', args: ['c++'] },
    { cmd: 'g++', args: [] },
    { cmd: 'clang++', args: [] },
  ];
  for (const c of candidatos) {
    try {
      execFileSync(c.cmd, c.args.length ? ['version'] : ['--version'], { stdio: 'ignore' });
      return c;
    } catch { /* tenta o proximo */ }
  }
  return null;
}

const comp = acharCompilador();
if (!comp) {
  console.error('\nNenhum compilador C++ encontrado.');
  console.error('Instale o Zig (portatil, so descompactar) em ~/tools/:');
  console.error('  https://ziglang.org/download/\n');
  process.exit(1);
}

const saida = path.join(__dirname, 'sim', 'firmware_sim.exe');
const args = [
  ...comp.args,
  '-std=c++17', '-O1',
  '-Wno-date-time',                 // o firmware carimba __DATE__ no banner
  '-Wno-nullability-completeness',
  '-I', path.join(__dirname, 'sim', 'stubs'),
  '-I', FW,
  '-DFIRMWARE_MAIN="' + MAIN.replace(/\\/g, '/') + '"',
  '-DFIRMWARE_NOME="autosteer_can_esp32"',
  path.join(__dirname, 'sim', 'harness.cpp'),
  '-o', saida,
];

console.log('firmware: ' + MAIN);
console.log('compilando...');
try {
  execFileSync(comp.cmd, args, { stdio: ['ignore', 'inherit', 'pipe'] });
  console.log('pronto:   ' + saida);
} catch (e) {
  const err = (e.stderr || Buffer.alloc(0)).toString();
  // esconde o ruido dos cabecalhos do proprio compilador
  const relevante = err.split('\n').filter((l) => !l.includes('libcxx')).join('\n');
  console.error(relevante || err);
  process.exit(1);
}
