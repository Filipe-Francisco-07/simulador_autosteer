// Aba de configuracao do tradutor — protótipo do chamado 15.
//
// Roda no monitor Windows, ANTES do AgIO, enquanto a porta serial do tradutor
// ainda esta livre. Le a configuracao que o modulo tem hoje, compara com o
// perfil do trator escolhido, grava o que diverge e confere lendo de volta.
//
// POR QUE ANTES DO AgIO, E NAO DENTRO DELE
//   1. o AgIO abre e SEGURA a porta do tradutor (spSteerModule em
//      SerialComm.Designer.cs); porta serial no Windows e exclusiva;
//   2. o AgIO roteia por numero de PGN e a tabela dele (UDP.designer.cs,
//      ReceiveFromLoopBack) tem 254, 252, 251, 239, 238 e 236 — o 240, que e o
//      do protocolo de servico, NAO esta la.
//
// Entao esta ferramenta e o PORTEIRO: ela abre primeiro, garante que o modulo
// esta configurado para aquele trator, e so entao libera o AgOpenGPS. Isso e
// exatamente o "aparece sobrepondo o software principal ate a configuracao
// ser efetuada" do chamado, sem precisar de janela sempre-no-topo.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');
const { Tradutor, conferir } = require('./tradutor.js');

const PORTA_WEB = 3100;
const ARQUIVO_PERFIS = path.join(__dirname, 'perfis.json');

// ---------------------------------------------------------------- perfis

// Um perfil por trator. O chamado pede "configurado independente para cada
// trator" — entao o perfil e a unidade, e o modulo e so onde ele e aplicado.
const PERFIL_PADRAO = {
  nome: 'Trator novo',
  contagensPorGrau: 19,
  ackerman: 100,
  correnteDesligamento: 9,
  estercoMaxEsquerdaGraus: 32,
  estercoMaxDireitaGraus: 32,
  velocidadeMinimaKmh: 1.5,
  ganhoP: 20,
  pwmAlto: 180,
  pwmBaixo: 30,
  pwmMinimo: 25,
  offsetDirecao: 0,
  set0: 56,
  set1: 0,
};

function lerPerfis() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_PERFIS, 'utf8'));
  } catch {
    return { ativo: null, perfis: [] };
  }
}

function gravarPerfis(d) {
  fs.writeFileSync(ARQUIVO_PERFIS, JSON.stringify(d, null, 2));
}

// ---------------------------------------------------------------- estado

let dados = lerPerfis();
const tradutor = new Tradutor();
let ultimaLeitura = null;
let ultimoErro = null;

const clientes = new Set();
const transmitir = (m) => {
  const t = JSON.stringify(m);
  for (const c of clientes) { try { c.send(t); } catch {} }
};

function perfilAtivo() {
  return dados.perfis.find((p) => p.nome === dados.ativo) || null;
}

// O veredito que decide se o AgOpenGPS pode abrir.
function situacao() {
  const perfil = perfilAtivo();
  if (!tradutor.ligado) return { estado: 'sem_modulo', texto: 'tradutor nao conectado' };
  if (!perfil) return { estado: 'sem_perfil', texto: 'nenhum trator escolhido' };
  if (!ultimaLeitura) return { estado: 'sem_leitura', texto: 'ainda nao li o modulo' };
  const dif = conferir(perfil, ultimaLeitura);
  if (dif.length) {
    return { estado: 'divergente', texto: dif.length + ' ajuste(s) fora do perfil', diferencas: dif };
  }
  return { estado: 'configurado', texto: 'o modulo esta como o perfil "' + perfil.nome + '" manda' };
}

function quadroDaTela() {
  return {
    t: 'tela',
    ligado: tradutor.ligado,
    origem: tradutor.origem,
    perfis: dados.perfis,
    ativo: dados.ativo,
    leitura: ultimaLeitura,
    situacao: situacao(),
    erro: ultimoErro,
  };
}

async function lerModulo() {
  ultimoErro = null;
  try {
    ultimaLeitura = await tradutor.ler();
  } catch (e) {
    ultimaLeitura = null;
    ultimoErro = e.message;
  }
  transmitir(quadroDaTela());
}

// ---------------------------------------------------------------- comandos

async function aplicarComando(c) {
  try {
    switch (c.acao) {
      case 'listarPortas': {
        const portas = await SerialPort.list();
        transmitir({ t: 'portas', portas: portas.map((p) => ({
          caminho: p.path, fabricante: p.manufacturer || '', id: p.pnpId || '' })) });
        break;
      }

      case 'conectar':
        ultimoErro = null;
        try {
          if (c.valor === 'simulado') await tradutor.abrirSimulado();
          else await tradutor.abrirPorta(c.valor);
          await lerModulo();
        } catch (e) {
          // Erro tipico: o AgIO ja esta com a porta. Vale dizer isso na tela,
          // senao o operador fica tentando de novo sem entender.
          ultimoErro = /Access denied|Acesso negado|busy/i.test(e.message)
            ? 'a porta esta ocupada — o AgIO esta aberto? feche-o e tente de novo'
            : e.message;
          transmitir(quadroDaTela());
        }
        break;

      case 'desconectar':
        await tradutor.fechar();
        ultimaLeitura = null;
        transmitir(quadroDaTela());
        break;

      case 'ler':
        await lerModulo();
        break;

      case 'salvarPerfil': {
        const p = { ...PERFIL_PADRAO, ...c.valor };
        const i = dados.perfis.findIndex((x) => x.nome === p.nome);
        if (i >= 0) dados.perfis[i] = p; else dados.perfis.push(p);
        dados.ativo = p.nome;
        gravarPerfis(dados);
        transmitir(quadroDaTela());
        break;
      }

      case 'escolherPerfil':
        dados.ativo = c.valor;
        gravarPerfis(dados);
        transmitir(quadroDaTela());
        break;

      case 'apagarPerfil':
        dados.perfis = dados.perfis.filter((p) => p.nome !== c.valor);
        if (dados.ativo === c.valor) dados.ativo = dados.perfis[0]?.nome || null;
        gravarPerfis(dados);
        transmitir(quadroDaTela());
        break;

      case 'gravarNoModulo': {
        const perfil = perfilAtivo();
        if (!perfil) { transmitir({ t: 'aviso', texto: 'escolha um trator primeiro' }); break; }
        transmitir({ t: 'aviso', texto: 'gravando...' });
        const r = await tradutor.gravar(perfil);
        // Espera a flash assentar: logo apos gravar, flashPendente ainda e true
        // e isso NAO quer dizer que persistiu.
        let u = r.conferencia, esperou = 0;
        while (u.flashPendente && esperou < 8000) {
          await new Promise((x) => setTimeout(x, 400));
          esperou += 400;
          u = await tradutor.ler();
        }
        ultimaLeitura = u;
        transmitir({ t: 'gravado', passos: r.passos, esperouFlashMs: esperou,
                     flashErro: u.flashErro, recusouLimites: r.recusouLimites });
        transmitir(quadroDaTela());
        break;
      }

      // Le o modulo e escreve um perfil com o que ele ja tem. Serve para
      // adotar um trator que ja estava configurado sem redigitar nada.
      case 'perfilDoModulo': {
        if (!ultimaLeitura) { transmitir({ t: 'aviso', texto: 'leia o modulo primeiro' }); break; }
        const l = ultimaLeitura;
        const p = {
          ...PERFIL_PADRAO,
          nome: c.valor || 'Trator ' + (dados.perfis.length + 1),
          contagensPorGrau: l.contagensPorGrau,
          ackerman: l.ackerman,
          correnteDesligamento: l.limiar,
          estercoMaxEsquerdaGraus: l.limiteEsquerdo / 100,
          estercoMaxDireitaGraus: l.limiteDireito / 100,
        };
        const i = dados.perfis.findIndex((x) => x.nome === p.nome);
        if (i >= 0) dados.perfis[i] = p; else dados.perfis.push(p);
        dados.ativo = p.nome;
        gravarPerfis(dados);
        transmitir(quadroDaTela());
        break;
      }

      default:
        transmitir({ t: 'aviso', texto: 'acao desconhecida: ' + c.acao });
    }
  } catch (e) {
    ultimoErro = e.message;
    transmitir(quadroDaTela());
  }
}

// ---------------------------------------------------------------- web

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8' };

const servidor = http.createServer((req, res) => {
  const nome = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const arq = path.join(__dirname, 'web', path.normalize(nome).replace(/^([/\\])+/, ''));
  if (!arq.startsWith(path.join(__dirname, 'web'))) { res.writeHead(403); return res.end(); }
  fs.readFile(arq, (e, b) => {
    if (e) { res.writeHead(404); return res.end('nao achei'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream' });
    res.end(b);
  });
});

new WebSocketServer({ server: servidor }).on('connection', (ws) => {
  clientes.add(ws);
  ws.send(JSON.stringify(quadroDaTela()));
  ws.on('close', () => clientes.delete(ws));
  ws.on('message', (d) => {
    let c; try { c = JSON.parse(d.toString()); } catch { return; }
    aplicarComando(c);
  });
});

// Releitura periodica: o modulo muda de estado sozinho (centra, engata, falha),
// e a tela tem que mostrar o agora, nao o de quando alguem apertou um botao.
setInterval(() => { if (tradutor.ligado) lerModulo(); }, 2000);

servidor.listen(PORTA_WEB, () => {
  console.log('\n  Configuracao do tradutor');
  console.log('  abra:  http://localhost:' + PORTA_WEB + '\n');
});
