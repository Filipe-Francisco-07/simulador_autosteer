// Quanto tempo leva uma volta da malha na bancada?
//
// PC injeta o heartbeat -> USB -> ESP32 processa -> ecoa o comando -> USB -> PC.
// Sao duas travessias de USB que no trator nao existem (la o CAN liga o modulo
// ao motor direto). Se esse atraso for grande, a malha oscila na bancada por
// causa do ARRANJO, nao do firmware — e e importante saber o numero para nao
// culpar o codigo por um problema da mesa.
const { SerialPort } = require('serialport');
const aog = require('../server/aog.js');
const { MotorKeya } = require('../server/motor.js');

const porta = new SerialPort({ path: process.argv[2] || 'COM3', baudRate: 38400 });
const motor = new MotorKeya();
let pbuf = Buffer.alloc(0);
let esperandoDesde = 0;
const idas = [];

porta.on('data', (d) => {
  pbuf = Buffer.concat([pbuf, d]);
  for (;;) {
    const i = pbuf.indexOf(Buffer.from([0x80, 0x81]));
    if (i < 0) { if (pbuf.length > 1) pbuf = pbuf.subarray(pbuf.length - 1); break; }
    if (i > 0) pbuf = pbuf.subarray(i);
    if (pbuf.length < 5) break;
    const total = 5 + pbuf[4] + 1;
    if (pbuf.length < total) break;
    const q = pbuf.subarray(0, total);
    // eco do comando CAN = a resposta ao heartbeat que mandamos
    if (q[3] === 0xF1 && esperandoDesde) { idas.push(Date.now() - esperandoDesde); esperandoDesde = 0; }
    pbuf = pbuf.subarray(total);
  }
});

function injetar(hex) {
  const b = Buffer.alloc(14);
  b[0]=0x80; b[1]=0x81; b[2]=0x7F; b[3]=0xF0; b[4]=8;
  Buffer.from(hex,'hex').copy(b,5);
  let s=0; for(let i=2;i<13;i++) s+=b[i]; b[13]=s&0xFF;
  porta.write(b);
}

const espera = ms => new Promise(r=>setTimeout(r,ms));
const cfg = aog.steerSettings({ganhoP:40,pwmAlto:180,pwmBaixo:30,pwmMinimo:25,contagensPorGrau:19,offsetDirecao:0,ackerman:100});
const cmd = aog.steerData({velocidadeKmh:5,engatar:true,anguloAlvoGraus:20,xte:0});

(async () => {
  await espera(2500);
  porta.write(cfg); await espera(300);
  console.log('medindo a volta da malha (heartbeat -> comando de volta)\n');
  for (let i = 0; i < 40; i++) {
    porta.write(cmd);
    motor.passo(50);
    esperandoDesde = Date.now();
    injetar(motor.heartbeat().hex);
    await espera(120);
  }
  await espera(400);
  idas.sort((a,b)=>a-b);
  const media = idas.reduce((s,v)=>s+v,0)/idas.length;
  console.log(`  amostras: ${idas.length}`);
  console.log(`  mais rapida: ${idas[0]} ms`);
  console.log(`  mediana:     ${idas[Math.floor(idas.length/2)]} ms`);
  console.log(`  media:       ${media.toFixed(1)} ms`);
  console.log(`  mais lenta:  ${idas[idas.length-1]} ms`);
  console.log(`\n  no trator o modulo fala CAN direto com o motor: essa espera nao existe la`);
  process.exit(0);
})();
