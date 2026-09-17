// Tela da aba de configuracao. Conversa por WebSocket com servidor.js.

const $ = (id) => document.getElementById(id);
const ws = new WebSocket('ws://' + location.host);
let estado = null;
let ignorouPortao = false;

const enviar = (acao, valor) => ws.send(JSON.stringify({ acao, valor }));

function anotar(texto) {
  const d = document.createElement('div');
  const h = new Date().toLocaleTimeString('pt-BR');
  d.textContent = h + '  ' + texto;
  $('registro').prepend(d);
  while ($('registro').childElementCount > 60) $('registro').lastChild.remove();
}

// ---- campos do formulario <-> perfil ----

const CAMPOS = {
  f_nome: 'nome',
  f_cpd: 'contagensPorGrau',
  f_ackerman: 'ackerman',
  f_corrente: 'correnteDesligamento',
  f_velmin: 'velocidadeMinimaKmh',
  f_esq: 'estercoMaxEsquerdaGraus',
  f_dir: 'estercoMaxDireitaGraus',
  f_kp: 'ganhoP',
  f_pwmalto: 'pwmAlto',
};

function preencher(p) {
  for (const [id, chave] of Object.entries(CAMPOS)) {
    $(id).value = p ? p[chave] : '';
  }
}

function coletar() {
  const p = {};
  for (const [id, chave] of Object.entries(CAMPOS)) {
    const v = $(id).value;
    p[chave] = chave === 'nome' ? v.trim() : Number(v);
  }
  return p;
}

// ---- desenho ----

const SELO = {
  configurado: ['ok', 'configurado'],
  divergente: ['atencao', 'fora do perfil'],
  sem_perfil: ['atencao', 'sem trator'],
  sem_leitura: ['atencao', 'sem leitura'],
  sem_modulo: ['mal', 'sem módulo'],
};

function desenhar(m) {
  estado = m;

  const [classe, rotulo] = SELO[m.situacao.estado] || ['atencao', m.situacao.estado];
  $('selo').className = 'selo ' + classe;
  $('selo').textContent = rotulo;
  $('origem').textContent = m.origem ? '· ' + m.origem : '';
  $('btnConectar').disabled = m.ligado;
  $('btnDesconectar').disabled = !m.ligado;
  $('btnLer').disabled = !m.ligado;
  $('btnGravar').disabled = !m.ligado || !m.ativo;
  $('btnDoModulo').disabled = !m.leitura;

  // lista de tratores
  const lista = $('listaPerfis');
  if (lista.dataset.assinatura !== JSON.stringify(m.perfis.map((p) => p.nome)) + m.ativo) {
    lista.dataset.assinatura = JSON.stringify(m.perfis.map((p) => p.nome)) + m.ativo;
    lista.innerHTML = '';
    for (const p of m.perfis) {
      const o = document.createElement('option');
      o.value = o.textContent = p.nome;
      o.selected = p.nome === m.ativo;
      lista.appendChild(o);
    }
    if (!m.perfis.length) {
      const o = document.createElement('option');
      o.textContent = '(nenhum trator cadastrado)';
      o.disabled = true; o.selected = true;
      lista.appendChild(o);
    }
    const ativo = m.perfis.find((p) => p.nome === m.ativo);
    if (ativo && document.activeElement.tagName !== 'INPUT') preencher(ativo);
  }

  // o que o modulo diz
  const t = $('leitura');
  if (!m.leitura) {
    t.innerHTML = '<tr><td class="rotulo">' +
      (m.erro ? m.erro : 'sem leitura') + '</td><td>—</td></tr>';
  } else {
    const l = m.leitura;
    const par = (r, v) => `<tr><td class="rotulo">${r}</td><td>${v}</td></tr>`;
    t.innerHTML =
      par('CPD', l.contagensPorGrau) +
      par('Ackerman', l.ackerman + '%') +
      par('Corrente deslig.', l.limiar + ' A') +
      par('Esterço esq/dir', (l.limiteEsquerdo / 100) + '° / ' + (l.limiteDireito / 100) + '°') +
      par('Referência', l.referencia ? 'de pé' : 'sem zero') +
      par('Trava', l.trava ? 'armada' : 'solta') +
      par('Falha', l.falhaNome) +
      par('Encoder', l.encoderAcumulado) +
      par('Flash', l.flashErro ? 'ERRO' : (l.flashPendente ? 'gravando…' : 'ok'));
  }

  // divergencias
  const box = $('divergencias');
  if (m.situacao.estado === 'divergente') {
    box.innerHTML = '<div class="dif"><b>O módulo está fora do perfil:</b><br>' +
      m.situacao.diferencas.map((d) =>
        `${d.nome}: módulo <b>${d.obtido}</b>, perfil pede <b>${d.pedido}</b>`).join('<br>') +
      '</div>';
  } else if (m.situacao.estado === 'configurado') {
    box.innerHTML = '<div class="dif" style="background:rgba(46,160,67,.10);' +
      'border-color:rgba(46,160,67,.35)"><b>Confere com o perfil.</b> ' +
      'O tradutor está pronto para este trator.</div>';
  } else {
    box.innerHTML = '';
  }

  // o portao
  const precisa = m.situacao.estado !== 'configurado';
  $('portao').classList.toggle('ligado', precisa && !ignorouPortao);
  $('portaoTexto').textContent = m.situacao.texto;
}

// ---- ligacoes ----

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === 'tela') return desenhar(m);
  if (m.t === 'portas') {
    const s = $('porta');
    s.innerHTML = '<option value="simulado">firmware no PC (sem placa)</option>';
    for (const p of m.portas) {
      const o = document.createElement('option');
      o.value = p.caminho;
      o.textContent = p.caminho + (p.fabricante ? ' — ' + p.fabricante : '');
      s.appendChild(o);
    }
    anotar(m.portas.length + ' porta(s) encontrada(s)');
    return;
  }
  if (m.t === 'aviso') return anotar(m.texto);
  if (m.t === 'gravado') {
    for (const p of m.passos) anotar('gravou: ' + p);
    anotar('flash assentou em ' + m.esperouFlashMs + ' ms' +
           (m.flashErro ? ' — ERRO DE FLASH' : ''));
    if (m.recusouLimites) anotar('ATENÇÃO: o módulo recusou o esterçamento máximo');
    // O portao so cai quando a releitura confirmar; nao adianta confiar no envio.
    ignorouPortao = false;
    return;
  }
};

ws.onopen = () => { anotar('conectado à ferramenta'); enviar('listarPortas'); };
ws.onclose = () => anotar('a ferramenta parou de responder');

$('btnListar').onclick = () => enviar('listarPortas');
$('btnConectar').onclick = () => enviar('conectar', $('porta').value);
$('btnDesconectar').onclick = () => enviar('desconectar');
$('btnLer').onclick = () => enviar('ler');
$('btnSalvar').onclick = () => {
  const p = coletar();
  if (!p.nome) return anotar('dê um nome ao trator antes de salvar');
  enviar('salvarPerfil', p);
  anotar('perfil "' + p.nome + '" salvo');
};
$('btnGravar').onclick = () => enviar('gravarNoModulo');
$('btnNovo').onclick = () => { preencher(null); $('f_nome').focus(); };
$('btnDoModulo').onclick = () => {
  const nome = prompt('Nome do trator para este perfil:', 'Trator ' + (estado.perfis.length + 1));
  if (nome) enviar('perfilDoModulo', nome.trim());
};
$('btnApagar').onclick = () => {
  if (!estado?.ativo) return;
  if (confirm('Apagar o perfil "' + estado.ativo + '"?')) enviar('apagarPerfil', estado.ativo);
};
$('listaPerfis').onchange = (e) => enviar('escolherPerfil', e.target.value);
$('btnIgnorar').onclick = () => { ignorouPortao = true; $('portao').classList.remove('ligado'); };
