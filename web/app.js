// Painel do simulador: mapa, volante e a bancada tecnica.

const ws = new WebSocket('ws://' + location.host);
const $ = (id) => document.getElementById(id);
const enviar = (acao, valor) => { if (ws.readyState === 1) ws.send(JSON.stringify({ acao, valor })); };

const nnSimples = (v) => Number(v).toFixed(1).replace('.', ',');
let placaLigadaAntes = false, placaMudaAntes = false;
let emRe = false;         // andando para tras agora
let marchaEhRe = false;   // marcha engatada e R — e isso que decide o que a tecla S faz

// ---------------------------------------------------------------- teclado
// Uma tecla so manda mensagem quando MUDA de estado — segurar W nao inunda o
// servidor com a repeticao automatica do teclado.
const teclasAtivas = new Set();
const mapaTeclas = {
  KeyW: 'acelerar', KeyS: 'reMarcha', Space: 'frear',
  KeyA: 'esqOn', KeyD: 'dirOn',
};

function soltarTecla(code) {
  const acao = mapaTeclas[code];
  if (!acao) return;
  teclasAtivas.delete(code);
  if (acao === 'reMarcha') { enviar('acelerar', false); enviar('frear', false); }
  else enviar(acao, false);
}

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  if (e.code === 'Enter') { e.preventDefault(); enviar('piloto'); return; }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { e.preventDefault(); enviar('marcha', +1); return; }
  if (e.code === 'ControlLeft' || e.code === 'ControlRight') { e.preventDefault(); enviar('marcha', -1); return; }

  const acao = mapaTeclas[e.code];
  if (!acao) return;
  e.preventDefault();
  if (teclasAtivas.has(e.code)) return;      // repeticao do teclado
  teclasAtivas.add(e.code);
  // S serve para os dois: em marcha a re ele acelera, senao freia.
  if (acao === 'reMarcha') enviar(marchaEhRe ? 'acelerar' : 'frear', true);
  else enviar(acao, true);
});

addEventListener('keyup', (e) => {
  if (!teclasAtivas.has(e.code)) return;
  e.preventDefault();
  soltarTecla(e.code);
});

// Perder o foco solta tudo, senao o trator sai andando sozinho.
addEventListener('blur', () => { for (const t of [...teclasAtivas]) soltarTecla(t); });

// ---------------------------------------------------------------- controles
$('btnPiloto').onclick = () => enviar('piloto');
$('btnA').onclick = () => enviar('marcarA');
$('btnB').onclick = () => enviar('marcarB');
$('btnRastro').onclick = () => enviar('limparRastro');
$('btnZero').onclick = () => enviar('wasZero');
$('btnAplicarCal').onclick = () => enviar('aplicarCalibragem');
$('btnZerarCal').onclick = () => { enviar('reiniciarCalibragem'); anotar('calibragem: recomecando a medida'); };
$('btnReset').onclick = () => {
  enviar('reset');
  $('eventos').innerHTML = '';
  // o servidor volta ao padrao e reenvia o estado; aqui so limpamos o que e
  // puramente visual
  document.querySelectorAll('.chave input').forEach((c) => { c.checked = c.id === 'reverseOn'; });
  $('blocoAog').classList.remove('desligado');
};

const deslizante = (id, acao, formatar, rotulo, transformar) => {
  const el = $(id);
  const mostrar = () => { if (rotulo) $(rotulo).textContent = formatar(el.value); };
  el.oninput = () => { mostrar(); enviar(acao, transformar ? transformar(el.value) : el.value); };
  mostrar();
};
deslizante('escorrega', 'escorregamento', (v) => v + '%', 'vEscorrega', (v) => v / 100);
deslizante('cpdReal', 'cpdReal', (v) => v, 'vCpdReal');
deslizante('batente', 'batente', (v) => v + '°', 'vBatente');
deslizante('velMotor', 'velMotor', (v) => Number(v).toFixed(1).replace('.', ',') + ' v/s', 'vVelMotor');
deslizante('largura', 'largura', (v) => Number(v).toFixed(1).replace('.', ',') + ' m', 'vLargura');

const chave = (id, acao, inverter) => {
  $(id).onchange = (e) => enviar(acao, inverter ? !e.target.checked : e.target.checked);
};
chave('mao', 'maoNoVolante');
chave('travado', 'motorTravado');
chave('canMudo', 'motorRespondendo', true);
chave('reverseOn', 'reverseOn');
chave('steerInReverse', 'steerInReverse');
$('sentidoInvertido').onchange = (e) => enviar('sentidoMontagem', e.target.checked ? 1 : -1);
$('aogMudo').onchange = (e) => {
  enviar('aogLigado', !e.target.checked);
  $('blocoAog').classList.toggle('desligado', e.target.checked);
};

const mandarAjustes = () => enviar('ajustes', {
  ganhoP: +$('ganhoP').value, contagensPorGrau: +$('cpd').value,
  pwmMinimo: +$('pwmMin').value, pwmAlto: +$('pwmAlto').value,
});
['ganhoP', 'cpd', 'pwmMin', 'pwmAlto'].forEach((id) => { $(id).onchange = mandarAjustes; });

// ---------------------------------------------------------------- a placa
$('btnProcurar').onclick = () => enviar('listarPortas');
$('btnConectar').onclick = () => {
  const caminho = $('portas').value;
  if (!caminho) { anotar('escolha a porta da placa primeiro'); return; }
  enviar('conectarPlaca', { caminho, baud: +$('baud').value });
};
$('btnDesconectar').onclick = () => enviar('desconectarPlaca');
$('btnVoltarSimulado').onclick = () => { enviar('desconectarPlaca'); $('avisoTentou').hidden = true; };
$('btnReiniciarPlaca').onclick = () => enviar('reiniciarPlaca');

function mostrarPortas(portas) {
  const sel = $('portas');
  const antes = sel.value;
  sel.innerHTML = '';
  if (!portas.length) {
    sel.innerHTML = '<option value="">nenhuma porta encontrada</option>';
    return;
  }
  for (const p of portas) {
    const o = document.createElement('option');
    o.value = p.caminho;
    o.textContent = p.caminho + (p.provavel ? '  (parece o módulo)' : p.nome ? '  ' + p.nome : '');
    if (p.provavel) o.dataset.provavel = '1';
    sel.appendChild(o);
  }
  // pre-seleciona a que tem cara de ser a placa
  const provavel = portas.find((p) => p.provavel);
  sel.value = antes && portas.some((p) => p.caminho === antes) ? antes
            : (provavel ? provavel.caminho : portas[0].caminho);
}

function aplicarModo(modo, placa) {
  const naPlaca = modo === 'placa' && placa && placa.estado === 'ligada';
  const bancada = naPlaca && placa.bancada;
  document.querySelector('.faixa-modo').classList.toggle('naplaca', naPlaca);
  document.querySelector('.faixa-modo').classList.toggle('bancada', bancada);
  $('modoAtual').textContent = !naPlaca ? 'simulado no PC'
    : bancada ? ('ESP32 na ' + placa.caminho + ' — malha fechada')
    : ('ESP32 na ' + placa.caminho);
  $('modoNota').textContent = !naPlaca
    ? 'a malha fecha inteira, com o motor Keya de mentira'
    : bancada
      ? 'firmware de bancada: o ESP32 traduz de verdade e o PC faz o papel do motor'
      : placa.baud + ' baud · a serial é de verdade; o motor não está no barramento';
  // o aviso de "aqui o piloto nao esterca" so vale para o firmware de producao
  $('avisoPlaca').hidden = !naPlaca || bancada;
  $('avisoMuda').hidden = !(naPlaca && placa && placa.muda);
  $('btnConectar').hidden = naPlaca;
  $('btnDesconectar').hidden = !naPlaca;
  $('btnReiniciarPlaca').hidden = !naPlaca;
  $('portas').disabled = naPlaca;
  $('baud').disabled = naPlaca;
}

// ---------------------------------------------------------------- registro
const eventos = $('eventos');
function anotar(texto) {
  const l = document.createElement('div');
  l.innerHTML = `<span class="t">${new Date().toLocaleTimeString('pt-BR')}</span><span class="ev">${texto}</span>`;
  eventos.appendChild(l);
  while (eventos.childElementCount > 150) eventos.removeChild(eventos.firstChild);
  eventos.scrollTop = eventos.scrollHeight;
}

// ---------------------------------------------------------------- mapa
const cv = $('mapa');
const ctx = cv.getContext('2d');
let escala = 6;   // pixels por metro

function ajustarTamanho() {
  const r = cv.parentElement.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, r.width * dpr);
  cv.height = Math.max(1, r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', ajustarTamanho);
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  escala = Math.max(1.5, Math.min(24, escala * (e.deltaY < 0 ? 1.12 : 0.89)));
}, { passive: false });

function desenharMapa(d) {
  const t = d.trator, g = d.guia;
  const L = cv.clientWidth, A = cv.clientHeight;
  ctx.clearRect(0, 0, L, A);
  ctx.save();
  ctx.translate(L / 2, A / 2);

  // A camera segue o trator, mas o mapa NAO gira: fica mais facil comparar a
  // trajetoria com a linha AB.
  const mx = (x) => (x - t.x) * escala;
  const my = (y) => -(y - t.y) * escala;

  // grade de 10 m
  ctx.strokeStyle = '#D5D1C4'; ctx.lineWidth = 1;
  const passo = 10 * escala;
  const ox = ((-t.x * escala) % passo + passo) % passo;
  const oy = ((t.y * escala) % passo + passo) % passo;
  ctx.beginPath();
  for (let x = -L / 2 + ox - passo; x < L / 2; x += passo) { ctx.moveTo(x, -A / 2); ctx.lineTo(x, A / 2); }
  for (let y = -A / 2 + oy - passo; y < A / 2; y += passo) { ctx.moveTo(-L / 2, y); ctx.lineTo(L / 2, y); }
  ctx.stroke();

  // linha AB e as paralelas de trabalho (3 m entre passadas)
  if (g.temLinha) {
    const dx = Math.sin(g.rumoLinha), dy = Math.cos(g.rumoLinha);
    const meio = 400;
    const larguraMapa = g.largura || 4;
    for (let n = -6; n <= 6; n++) {
      const desloc = n * larguraMapa;
      const px = g.a.x + desloc * Math.cos(g.rumoLinha);
      const py = g.a.y - desloc * Math.sin(g.rumoLinha);
      ctx.beginPath();
      ctx.moveTo(mx(px - dx * meio), my(py - dy * meio));
      ctx.lineTo(mx(px + dx * meio), my(py + dy * meio));
      if (n === g.passada) {
        // a passada que o piloto esta seguindo agora
        ctx.strokeStyle = '#26597D'; ctx.lineWidth = 2.5; ctx.setLineDash([]);
      } else if (n === 0) {
        ctx.strokeStyle = 'rgba(38,89,125,.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(38,89,125,.25)'; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = '600 12px IBM Plex Sans Condensed';
    for (const [p, nome] of [[g.a, 'A'], [g.b, 'B']]) {
      ctx.fillStyle = '#26597D';
      ctx.beginPath(); ctx.arc(mx(p.x), my(p.y), 4, 0, 7); ctx.fill();
      ctx.fillText(nome, mx(p.x) + 7, my(p.y) - 6);
    }
  }

  // rastro: verde de frente, laranja de re
  if (t.rastro.length > 1) {
    let modo = null;
    ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let i = 1; i < t.rastro.length; i++) {
      const p = t.rastro[i];
      if (p.re !== modo) {
        if (modo !== null) ctx.stroke();
        modo = p.re;
        ctx.strokeStyle = p.re ? 'rgba(169,106,30,.75)' : 'rgba(74,124,65,.55)';
        ctx.beginPath();
        ctx.moveTo(mx(t.rastro[i - 1].x), my(t.rastro[i - 1].y));
      }
      ctx.lineTo(mx(p.x), my(p.y));
    }
    ctx.stroke();
  }

  // o trator
  ctx.save();
  ctx.rotate(t.rumo);
  const C = 3.4 * escala, LG = 1.9 * escala;
  ctx.fillStyle = '#4A7C41'; ctx.strokeStyle = '#2C4A27'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.rect(-LG / 2, -C * .62, LG, C); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#26292B';
  const rt = 0.9 * escala, rl = 0.42 * escala;
  ctx.fillRect(-LG / 2 - rl, C * .1, rl, rt);
  ctx.fillRect(LG / 2, C * .1, rl, rt);
  // rodas dianteiras, estercadas
  ctx.save();
  ctx.translate(0, -C * .45);
  ctx.rotate((d.motor.anguloRodasGraus || 0) * Math.PI / 180);
  ctx.fillRect(-LG / 2 - rl, -rt * .35, rl, rt * .7);
  ctx.fillRect(LG / 2, -rt * .35, rl, rt * .7);
  ctx.restore();
  ctx.fillStyle = '#E8C33A';
  ctx.beginPath(); ctx.moveTo(0, -C * .72); ctx.lineTo(-LG * .22, -C * .58);
  ctx.lineTo(LG * .22, -C * .58); ctx.closePath(); ctx.fill();
  ctx.restore();

  // seta do rumo que o AOG ACHA. Quando aponta ao contrario do trator, e o
  // chamado 7 acontecendo na sua frente.
  const difRumo = Math.abs(((g.rumoQueOAogUsa - t.rumo + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const errado = difRumo > 1.57;
  ctx.save();
  ctx.rotate(g.rumoQueOAogUsa);
  const cor = errado ? '#B93225' : 'rgba(38,89,125,.5)';
  ctx.strokeStyle = cor; ctx.fillStyle = cor; ctx.lineWidth = errado ? 3 : 2;
  const comp = escala * 7;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -comp); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -comp); ctx.lineTo(-5, -comp + 8); ctx.lineTo(5, -comp + 8);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  ctx.restore();

  // regua de escala
  ctx.fillStyle = '#5E6360'; ctx.font = '500 11px IBM Plex Mono';
  ctx.fillText('10 m', 12, A - 13);
  ctx.strokeStyle = '#5E6360'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(46, A - 17); ctx.lineTo(46 + 10 * escala, A - 17); ctx.stroke();
}

// ---------------------------------------------------------------- recepcao
let ant = {};
ws.onopen = () => {
  $('conexao').textContent = 'ligada';
  ajustarTamanho();
  enviar('listarPortas');
};
ws.onclose = () => { $('conexao').textContent = 'caiu — reinicie o servidor'; };

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);

  if (m.t === 'portas') { mostrarPortas(m.portas); return; }
  if (m.t === 'placa') {
    aplicarModo(m.modo || (m.estado === 'ligada' ? 'placa' : 'simulado'), m);
    if (m.estado === 'erro') anotar('placa: ' + (m.erro || 'falhou ao abrir a porta'));
    if (m.estado === 'ligada' && !placaLigadaAntes) anotar('placa conectada em ' + m.caminho);
    if (m.muda && !placaMudaAntes) anotar('a porta ' + m.caminho + ' abriu mas nao responde — porta ou baud errado');
    placaLigadaAntes = m.estado === 'ligada';
    placaMudaAntes = !!m.muda;
    if (m.estado === 'desligada') anotar('placa desconectada');
    return;
  }
  // resposta do "Aplicar no AgOpenGPS"
  if (m.t === 'calibragem') {
    anotar(m.ok
      ? `calibragem aplicada: CPD ${m.antes.cpd} -> ${m.agora.cpd}, offset ${m.agora.offset}`
      : 'calibragem nao aplicada: ' + m.motivo);
    return;
  }
  if (m.t === 'limparTextoPlaca') { $('textoPlaca').innerHTML = ''; return; }
  if (m.t === 'textoPlaca') {
    const el = $('textoPlaca');
    el.hidden = false;
    const l = document.createElement('div');
    l.textContent = m.texto;
    el.appendChild(l);
    while (el.childElementCount > 40) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
    return;
  }

  if (m.t === 'sincronizar') {
    aplicarModo(m.modo, m.placa);
    if (m.textoDaPlaca && m.textoDaPlaca.length) {
      const el = $('textoPlaca');
      el.hidden = false;
      el.innerHTML = m.textoDaPlaca.map((t) => '<div></div>').join('');
      [...el.children].forEach((d, i) => { d.textContent = m.textoDaPlaca[i]; });
    }
    $('mao').checked = m.motor.maoNoVolante;
    $('travado').checked = m.motor.travado;
    $('canMudo').checked = !m.motorRespondendo;
    $('aogMudo').checked = !m.aogLigado;
    $('sentidoInvertido').checked = m.motor.sentidoMontagem === 1;
    $('reverseOn').checked = m.isReverseOn;
    $('steerInReverse').checked = m.isSteerInReverse;
    $('escorrega').value = Math.round(m.motor.escorregamento * 100);
    $('vEscorrega').textContent = Math.round(m.motor.escorregamento * 100) + '%';
    $('cpdReal').value = m.motor.contagensPorGrauReal;
    $('vCpdReal').textContent = m.motor.contagensPorGrauReal;
    $('batente').value = m.motor.batenteGraus;
    $('vBatente').textContent = m.motor.batenteGraus + '°';
    if (m.largura) { $('largura').value = m.largura; $('vLargura').textContent = nnSimples(m.largura) + ' m'; }
    $('velMotor').value = m.motor.voltasPorSegundoMax;
    $('vVelMotor').textContent = m.motor.voltasPorSegundoMax.toFixed(1).replace('.', ',') + ' v/s';
    $('ganhoP').value = m.ajustes.ganhoP; $('cpd').value = m.ajustes.contagensPorGrau;
    $('pwmMin').value = m.ajustes.pwmMinimo; $('pwmAlto').value = m.ajustes.pwmAlto;
    $('blocoAog').classList.toggle('desligado', !m.aogLigado);
    return;
  }
  if (m.t !== 'tela') return;

  const f = m.firmware || {}, mo = m.motor || {}, t = m.trator || {}, g = m.guia || {};
  if (m.modo) aplicarModo(m.modo, m.placa);
  emRe = t.velocidade < -0.1;
  marchaEhRe = !!t.marchaEhRe;

  if (!cv.width || cv.clientWidth === 0) ajustarTamanho();
  desenharMapa(m);

  // volante: varias voltas de batente a batente, como num trator de verdade
  $('giroVolante').setAttribute('transform', `rotate(${(mo.anguloRodasGraus || 0) * 9})`);
  const piloto = !!f.autosteerLigado;
  $('quemDirige').textContent = piloto ? 'piloto no comando' : 'você no volante';
  $('quemDirige').classList.toggle('piloto', piloto);

  const est = (f.anguloAtualX100 || 0) / 100, real = mo.anguloRodasGraus || 0;
  const dif = est - real;
  const nn = (v, d = 1) => v.toFixed(d).replace('.', ',');
  $('mVel').innerHTML = nn(Math.abs(t.velocidade)) + '<small>km/h</small>';
  $('mMarcha').textContent = t.marcha;
  $('boxMarcha').classList.toggle('re', marchaEhRe);
  $('mFw').innerHTML = nn(est) + '<small>°</small>';
  $('mRoda').innerHTML = nn(real) + '<small>°</small>';
  $('mDiv').innerHTML = (dif >= 0 ? '+' : '') + nn(dif) + '<small>°</small>';
  $('boxDiv').classList.toggle('ruim', Math.abs(dif) >= 2);
  // Distancia ate a PASSADA que ele segue — e nisso que o piloto trabalha.
  // Mostrar a distancia ate a linha AB original faria parecer que ele esta
  // longe quando na verdade esta em cima da paralela certa.
  const largura = g.largura || 4;
  const xtePassada = g.temLinha ? g.xte - Math.round(g.xte / largura) * largura : 0;
  $('mXte').innerHTML = g.temLinha ? (xtePassada >= 0 ? '+' : '') + nn(xtePassada, 2) + '<small>m</small>' : '--';
  // Na placa so existe o que o PGN 253 traz. Corrente, encoder e as bandeiras
  // internas vivem dentro do ESP32 e nao saem de la — mostrar tracinho e mais
  // honesto (e mais util) do que mostrar zero como se fosse leitura.
  const naPlaca = f.deQuem === 'placa';
  const bancada = naPlaca && m.placa && m.placa.bancada;
  const semLeitura = '<small>—</small>';
  $('mPwm').textContent = f.pwmSaida ?? 0;
  $('mCorrente').innerHTML = naPlaca ? semLeitura : nn(f.correnteMedia || 0) + '<small>A</small>';
  $('mEncoder').innerHTML = naPlaca ? semLeitura : String(Math.round(f.encoderAcumulado || 0));
  $('mAlvo').innerHTML = nn(g.alvo || 0) + '<small>°</small>';

  // Calibragem pelo GPS. Enquanto nao houver passeio suficiente ele diz o que
  // falta em vez de mostrar numero — numero inventado aqui manda o operador
  // configurar errado com confianca.
  const c = m.calibragem;
  if (c && c.pronto) {
    $('cCpd').innerHTML = nn(c.cpd, 1) + (c.invertido ? ' <small>invertido!</small>' : '');
    $('cCentro').textContent = Math.round(c.centro);
    $('cR2').innerHTML = 'R²&nbsp;' + c.r2.toFixed(2);
    const laudo = $('cLaudo');
    if (laudo.dataset.n !== String(c.n)) {
      laudo.dataset.n = String(c.n);
      laudo.innerHTML = '';
      for (const l of (c.laudo || [])) {
        const d = document.createElement('div');
        d.textContent = l;
        laudo.appendChild(d);
      }
    }
  } else {
    $('cCpd').innerHTML = semLeitura;
    $('cCentro').innerHTML = semLeitura;
    $('cR2').innerHTML = semLeitura;
    $('cLaudo').textContent = c ? ('faltando: ' + c.motivo) : '';
  }

  $('seloPos').textContent =
    `${(t.percorrido || 0).toFixed(0)} m percorridos · rumo ${((t.rumo || 0) * 180 / Math.PI).toFixed(0)}°`;
  $('seloXte').textContent = g.temLinha
    ? (g.passada === 0
        ? `seguindo a linha AB · ${nn(Math.abs(xtePassada), 2)} m ${xtePassada >= 0 ? 'à direita' : 'à esquerda'}`
        : `seguindo a passada ${g.passada > 0 ? '+' : ''}${g.passada} (${nn(Math.abs(g.passada * largura), 0)} m da AB) · ${nn(Math.abs(xtePassada), 2)} m ${xtePassada >= 0 ? 'à direita' : 'à esquerda'}`)
    : (g.a ? 'A marcado — ande um pouco e marque B' : 'sem linha AB — ande um pouco e marque A, depois B');

  // o rumo do AOG aponta ao contrario do trator? e o chamado 7 acontecendo
  const rumoErrado = emRe && !g.aogEmRe;
  $('seloRe').hidden = !rumoErrado;

  // Pedir o piloto na placa nao faz nada, e ficar tentando sem entender por
  // que e o pior lugar para deixar alguem. Avisa no momento do pedido.
  $('avisoTentou').hidden = !(naPlaca && !m.placa.bancada && g.pilotoPedido);

  $('btnPiloto').textContent = g.pilotoPedido ? 'Desengatar piloto' : 'Engatar piloto';
  $('btnPiloto').classList.toggle('ligado', !!g.pilotoPedido);

  const bandeira = (id, on, perigo) => {
    const el = $(id);
    el.classList.toggle('on', !!on && !perigo);
    el.classList.toggle('perigo', !!on && !!perigo);
  };
  bandeira('bLigado', piloto, false);
  bandeira('bTrava', f.travaSeguranca, true);
  bandeira('bKeya', f.keyaVisto, false);
  bandeira('bRe', emRe, rumoErrado);
  // na placa nao da para saber trava nem se o motor foi visto: apaga em vez de
  // deixar o estado do modo anterior aceso
  $('bTrava').classList.toggle('indisponivel', naPlaca);
  $('bKeya').classList.toggle('indisponivel', naPlaca);
  $('bLigado').classList.toggle('indisponivel', naPlaca);

  // eventos: so o que mudou
  if (ant.piloto !== undefined) {
    if (!ant.piloto && piloto) anotar('piloto ENGATOU');
    if (ant.piloto && !piloto) {
      let motivo = 'o AOG parou de pedir';
      if (f.travaSeguranca && !ant.trava) motivo = 'trava de segurança (corrente alta)';
      else if (!m.aog.ligado) motivo = 'cão de guarda: o AOG parou de mandar';
      else if (!m.aog.motorRespondendo) motivo = 'cão de guarda: o motor parou de responder';
      else if (g.aogEmRe && !g.isSteerInReverse) motivo = 'entrou em ré e "esterçar de ré" está desligado';
      anotar('piloto SOLTOU — ' + motivo);
    }
    if (!ant.trava && f.travaSeguranca) anotar('trava de segurança ARMADA');
    if (ant.trava && !f.travaSeguranca) anotar('trava de segurança liberada');
    if (!ant.rumoErrado && rumoErrado) anotar('rumo do AOG INVERTIDO na ré (chamado 7)');
    if (!ant.temLinha && g.temLinha) anotar('linha AB criada');
  }
  ant = { piloto, trava: f.travaSeguranca, rumoErrado, temLinha: g.temLinha };
};
