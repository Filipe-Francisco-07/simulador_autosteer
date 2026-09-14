# Simulador de tradução — firmware do autosteer

Banco de testes para o módulo que traduz **AgOpenGPS ↔ motor Keya**, do
AgroPreciso. Serve para estressar o firmware no PC, antes de subir no trator.

Referente ao chamado "Teste de tradução - Firmware do Autosteer" (issue 10 do
`automacao_agricola`).

---

## O que é, em uma frase

Você dirige um trator na tela e fica dos **dois lados** do módulo ao mesmo
tempo: o AgOpenGPS que guia e o motor que obedece, com o firmware de verdade
traduzindo no meio.

```
   você                    firmware REAL                    você
   ────                    ─────────────                    ────
 AgOpenGPS  ──PGN 254/252──►  main.cpp  ──CAN Keya──►   motor Keya
 simulado   ◄────PGN 253────  compilado ◄──heartbeat──   simulado
```

## O firmware é o de verdade, não uma cópia

Este repositório **não tem cópia do firmware**. O build aponta para o arquivo
do repo AgroPreciso e compila `main.cpp` como ele é, trocando só o que é
hardware (Serial, CAN e o relógio) por dublês em `sim/stubs/`.

Consequência prática: **se o simulador achar um bug, o bug está no firmware que
vai gravado no ESP32**. E quando o Pedro mexer no firmware, o próximo build já
pega a versão nova.

O truque para isso funcionar está em `sim/harness.cpp`: ele faz `#include` do
`main.cpp` em vez de linkar, porque as variáveis de estado do firmware são
`static` e só ficam visíveis dentro da mesma unidade de compilação. É assim que
o painel consegue mostrar a trava de segurança e a corrente média por dentro.

## Dois modos

| | O que é | Para que serve |
|---|---|---|
| **Simulado** (padrão) | o `main.cpp` compilado rodando no PC, com o motor Keya de mentira | a lógica do firmware e a malha fechando inteira |
| **Placa** | o ESP32 de verdade na USB | a comunicação real: serial, baud e o tempo do ESP32 |

O modo placa exige o driver CH340 e **não fecha a malha** (o motor mora no
barramento CAN, que o PC não vê). Detalhes em
[docs/02-usar-a-placa.md](docs/02-usar-a-placa.md).

## Como rodar

Precisa de **Node.js** e de um compilador C++. Se não tiver compilador, o mais
simples é o [Zig](https://ziglang.org/download/) (é um `.zip`, não instala
nada): descompacte em `~/tools/` e o build acha sozinho.

```bash
npm install
npm run build     # compila o firmware do AgroPreciso para rodar aqui
npm start         # sobe o simulador
```

Abra <http://localhost:3000>.

Se os repositórios não estiverem lado a lado, aponte o firmware:

```bash
set FIRMWARE_SRC=C:\caminho\autosteer_can_esp32\src
npm run build
```

## Dirigindo

| Tecla | O que faz |
|---|---|
| `W` | acelerar |
| `S` | ré (quando a marcha engatada é R) / freio nas demais |
| `espaço` | freio |
| `A` `D` | girar o volante na mão (só vale com o piloto desligado) |
| `shift` `ctrl` | marcha acima / abaixo — R2, R1, N, 1 a 6 |
| `enter` | engatar e desengatar o piloto |

A roda do mouse dá zoom no mapa.

**Para o piloto engatar é preciso ter uma linha AB** — igual ao AOG de verdade,
que recusa engatar sem linha. Ande um pouco, aperte **Marcar A**, ande mais e
aperte **Marcar B**. As paralelas de 3 m aparecem sozinhas e o piloto segue a
mais próxima, não a central.

No mapa: rastro **verde** andando para frente, **laranja** de ré, e uma seta
mostrando o rumo que o AOG *acha* que o trator tem. Quando essa seta aponta ao
contrário do trator, é o chamado 7 acontecendo na sua frente.

## O painel

| Bloco | Quem é você | O que dá para fazer |
|---|---|---|
| **AgOpenGPS** | o software na cabine | engatar, Kp/CPD/PWM, zerar as rodas, as duas chaves da ré, **cortar o cabo** |
| **Firmware** | ninguém — é o que está sendo testado | PWM, corrente média, encoder, ângulo pedido, registro de eventos |
| **Motor Keya** | o hardware | mão no volante, travar o motor, **cortar o CAN**, montar ao contrário, escorregamento do orbitrol, velocidade do motor, batente |

Nos instrumentos, a pergunta que importa: **o que o firmware acha** contra
**onde a roda está de verdade**. Enquanto os dois andam juntos, o encoder está
dando conta. Quando descolam, é o WAS pedindo passagem.

## O bug da ré (chamado 7)

O simulador reproduz o problema relatado em campo. São duas chaves diferentes,
as mesmas do AgOpenGPS de verdade:

- **Detectar ré (Reverse On)** — o AOG percebe que o trator anda para trás.
  **Desligue e ande de ré**: o rumo trava apontando para frente, a seta no mapa
  fica vermelha e o piloto esterça para o lado errado. É o sintoma do chamado.
- **Esterçar de ré** — se o piloto continua trabalhando de ré. Desligado (o
  padrão), ele solta sozinho ao detectar ré, que é o comportamento seguro.

## O teste do WAS (item 2.4 do chamado)

O controle **escorregamento do orbitrol** existe para isso. O encoder conta
voltas do *motor*; a roda só acompanha se o orbitrol não perder. Suba o
escorregamento e veja a diferença crescer: é a medida de quanto o sistema sem
WAS erra. Vale testar também **contagens por grau reais** diferente do CPD
configurado no AOG — é o caso de a calibração estar simplesmente errada.

### Calibragem pelo GPS

Desde 07/09 tem um caminho para responder isso sem sensor nenhum: o painel
**Calibragem pelo GPS** mede o ângulo real das rodas pela curvatura do caminho e
descobre o CPD, o centro e se o motor está montado ao contrário. Bota o CPD real
num valor e o configurado noutro, dá um passeio esterçando para os dois lados, e
veja ele achar a diferença.

Detalhes e limites em [docs/07-calibragem-por-gps.md](docs/07-calibragem-por-gps.md).

## Coisas que valem a pena tentar quebrar

Não é lista de tarefas nem roteiro fechado; é ponto de partida. O chamado pede
uma pessoa estressando de verdade, e é isso que encontra o que ninguém previu.

- engatar na linha e ver se ele entra e fica, ou se serpenteia
- segurar o volante e conferir se o módulo **continua** solto (não só um ciclo)
- dar ré com e sem a detecção ligada (ver o chamado 7 acontecer)
- trocar de marcha no meio da guiagem, acelerar até a marcha 6
- cortar o cabo do AOG com o piloto engatado
- cortar o CAN com o piloto engatado
- pedir um ângulo maior que o batente e ver a corrente subir
- zerar as rodas com o volante torto e engatar em seguida
- empurrar o encoder para o estouro de 16 bits enquanto ele esterça
- montar o motor ao contrário e ver a malha divergir em vez de convergir
- mexer no Kp e no PWM mínimo até achar onde ele oscila ou onde fica preguiçoso
- desengatar e reengatar rápido, várias vezes seguidas

## Conferência automática

```bash
node server/malha-teste.js         # três alvos: o conjunto chega e fica?
node testes/seguranca.js           # o que acontece quando algo dá errado andando
node testes/calibragem.js          # a medida pelo GPS acerta a verdade conhecida?
node testes/corrigir-cpd.js        # CPD errado -> GPS descobre -> aplica -> confere
node testes/descoberta.js          # o modulo responde ao "quem esta ai" do AgIO?
```

**Não substituem o teste na mão** — só garantem que o simulador está montado
certo antes de alguém gastar tempo com ele.

`testes/calibragem.js` roda sozinho, sem servidor. Os outros precisam do
`npm run dev` de pé.

## O que este simulador NÃO prova

Honestidade sobre os limites, para ninguém confiar demais no resultado:

- **A velocidade do motor é chute, e ela muda tudo.** O comando do Keya é "por
  mil da velocidade nominal" e a nominal do KY173 não foi aferida por nós. Por
  isso virou um controle na tela (padrão 4 voltas/s): é ele que decide se o
  piloto corrige antes de o trator sair da linha. **Cronometrar o motor real,
  batente a batente, resolve** — e até lá qualquer Kp daqui é provisório.
- **A física do trator é um modelo de bicicleta.** Sem patinagem, sem terreno,
  sem folga na direção. Serve para exercitar a lógica de guiagem, não para
  prever o comportamento na lavoura.
- **A guiagem daqui não é a do AgOpenGPS.** É uma lei no estilo Stanley,
  escrita para fechar a malha. O AOG real tem outros refinamentos, então o
  jeito de entrar na linha não vai ser idêntico.
- **O tempo é ideal.** Sem jitter de serial, sem perda de quadro, sem ruído no
  barramento, sem atraso de USB.
- **Não testa o lado do AgOpenGPS.** O PGN daqui é montado a partir da
  especificação; se o AOG real mandar algo diferente, o simulador não percebe.
- **Não é teste de campo.** Nada aqui substitui o trator.

## Documentação

- [docs/01-como-funciona.md](docs/01-como-funciona.md) — arquitetura e decisões
- [docs/02-usar-a-placa.md](docs/02-usar-a-placa.md) — usar o ESP32 real

## Arquivos

```
sim/harness.cpp       roda o firmware real e expõe os dois lados
sim/stubs/            dublês de Arduino e do CAN do ESP32
server/motor.js       motor Keya + coluna de direção + orbitrol
server/trator.js      física do trator, marchas, linha AB e guiagem
server/aog.js         monta e lê os quadros PGN
server/placa.js       conversa com o ESP32 real pela USB
server/server.js      relógio, ponte com o firmware e servidor web
server/malha-teste.js conferência rápida sem interface
web/                  o painel e o mapa
build.js              compila o firmware do AgroPreciso
```
