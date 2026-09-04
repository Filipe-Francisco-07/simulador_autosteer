# Como o simulador funciona por dentro

**Criado:** 2026-09-01. Repositório privado — não espelhar no central enquanto
o teste não fechar.

Documento para quem for mexer no código (ou retomar isto daqui a três meses).
Para *usar* o simulador, o `README.md` basta.

---

## A ideia central

O módulo de autosteer é um **tradutor**: de um lado fala PGN com o AgOpenGPS,
do outro fala CAN com o motor Keya. Testar isso no trator é caro e arriscado —
cada erro custa uma viagem e um susto.

Então trazemos os dois lados para o PC e deixamos o firmware **de verdade** no
meio:

```
   você                    firmware REAL                    você
   ────                    ─────────────                    ────
 AgOpenGPS  ──PGN 254/252──►  main.cpp  ──CAN Keya──►   motor Keya
 simulado   ◄────PGN 253────  compilado ◄──heartbeat──   simulado
```

O trator anda por cima disso: a linha AB gera um erro lateral, o erro vira
ângulo desejado, o firmware traduz, o motor gira as rodas, o trator muda de
rumo e sai um erro novo. A malha fecha inteira.

## Por que o firmware não é uma cópia

Reescrever a lógica em JavaScript seria mais rápido, e seria uma armadilha:
o teste passaria na *minha* tradução enquanto o bug continuaria no firmware
que vai gravado. Então compilamos o `main.cpp` do AgroPreciso como ele é.

Três coisas tornam isso possível:

1. **Os stubs** (`sim/stubs/`) trocam só o que é hardware. `Arduino.h` vira uma
   fila de bytes e um relógio que o simulador controla; `driver/twai.h` vira
   duas filas de quadros CAN. O firmware não percebe a diferença.
2. **O harness inclui o `.cpp`** em vez de linkar. As variáveis de estado do
   firmware são `static`, então só existem dentro da unidade de compilação —
   `#include "main.cpp"` é o que permite ao painel mostrar `travaSeguranca` e
   `correnteMedia` por dentro. Feio, e é o truque que faz a coisa funcionar.
3. **O build aponta para o repo AgroPreciso**, não para uma cópia local. Se o
   Pedro mexer no firmware, o próximo `npm run build` já pega.

## Quem faz o quê

| Arquivo | Responsabilidade |
|---|---|
| `sim/harness.cpp` | roda o firmware e conversa por stdin/stdout (linha a linha) |
| `sim/stubs/` | dublês de Arduino e do TWAI do ESP32 |
| `server/motor.js` | motor Keya: comando de velocidade, encoder, corrente, orbitrol |
| `server/trator.js` | física do trator (modelo de bicicleta), marchas, linha AB e guiagem |
| `server/aog.js` | monta e lê os quadros PGN |
| `server/placa.js` | conversa com o ESP32 de verdade pela USB |
| `server/server.js` | o relógio: amarra todos e transmite o estado para a tela |
| `web/` | painel, mapa e volante |

## O relógio

Tudo acontece num `setInterval` de 20 ms — a mesma cadência do heartbeat do
Keya. Cada tique, na ordem:

1. manda o firmware avançar 20 ms (`T 20`, que roda o `loop()` 20 vezes)
2. aplica o volante do operador, se ele estiver girando na mão
3. anda a física do motor e a do trator
4. entrega o heartbeat do motor
5. o AOG decide o ângulo e manda o PGN 254
6. pede o estado interno e transmite para a tela

No **modo placa** os passos 1, 4 e 6 somem: o ESP32 roda no relógio dele e o
CAN é físico.

## Os dois modos

| | Simulado | Placa (ESP32 real) |
|---|---|---|
| Firmware | `main.cpp` compilado como processo | gravado no ESP32 |
| Serial | fila de bytes em memória | USB de verdade, 38400 |
| Motor Keya | simulado, malha fecha | **não existe** — o CAN é físico |
| Estado interno | visível (variáveis `static`) | só o que o PGN 253 devolve |
| Serve para | lógica, casos-limite, guiagem | comunicação, baud, tempo real |

Nenhum dos dois substitui o outro. O simulado testa o raciocínio do firmware;
a placa testa se ele conversa de verdade.

### Detecção de porta muda

Os CH340 do projeto não têm número de série, então o Windows dá o COM pela
posição física do conector — trocar a tomada troca o número (está documentado
em `AgroPreciso/docs/autosteer-operacao-agopengps.md`). Abrir a porta certa não
garante nada: se em 3 segundos nenhum PGN chegar, o painel avisa que é porta ou
baud errado, em vez de deixar o operador olhando uma tela parada.

## Decisões que valem explicar

**A física do motor é o número mais incerto de tudo.** O comando do Keya é "por
mil da velocidade nominal" e a nominal do KY173 não foi aferida por nós. Isso
decide se o piloto corrige antes do trator sair da linha, então virou um
controle na tela em vez de uma constante escondida. Cronometrar o motor real,
batente a batente, fecha essa lacuna.

**O batente trava o motor, não só a roda.** A primeira versão deixava o encoder
correndo com a roda parada no fim de curso, e os números divergiam sem limite.
No trator o motor está preso à coluna: trava junto e a corrente sobe. A versão
certa reproduz o que o plano de calibração do Pedro avisa — ângulo máximo mal
ajustado dispara o override no meio da manobra de cabeceira.

**A guiagem é Stanley, não a do AgOpenGPS.** Começou com pure pursuit puro e
ele invertia o sinal quando o trator estava longe e apontando para fora: o
piloto fugia da linha em vez de voltar. Stanley se comporta nessa situação. Não
é o algoritmo do AOG real, então a *forma* de entrar na linha não vai ser
idêntica — o que se testa aqui é o tradutor, não a guiagem.

**O sentido de montagem é um controle, não uma constante.** O firmware tem
`SENTIDO = -1`; se o motor for montado ao contrário disso, a malha diverge em
vez de convergir. Já aconteceu na bancada em 29/08, então dá para reproduzir de
propósito.

## O que o simulador achou até agora

Nada no firmware, até este ponto. **Os quatro bugs encontrados foram do próprio
simulador** — e vale registrar, porque cada um teria virado um "achado" falso:

| Bug | Sintoma | Causa |
|---|---|---|
| parser de velocidade | motor voava para o batente | `(alta << 16) \| baixa` já devolve int32 com sinal em JS; eu convertia de novo |
| batente | ângulo estimado divergia sem limite | encoder contava com a roda parada no fim de curso |
| guiagem | trator fugia da linha em vez de voltar | pure pursuit inverte o sinal com erro grande |
| marcha | não saía da ré | troca para frente recusada em silêncio enquanto deslizava |

Com a placa de verdade (01/09) o quadro se mantém: a comunicação subiu de
primeira depois de gravar a ponte — banner correto, PGN 253 a ~8-10 Hz, nenhum
quadro perdido a 38400. O que apareceu foi ruído da ROM de boot do ESP32, que
fala em 74880 baud e vira lixo lido a 38400; o painel filtra isso pelo que
falha na decodificação UTF-8, para o banner chegar limpo.

Isso é o motivo de validar a ferramenta antes de confiar nela. Um simulador
errado não avisa que está errado: ele acusa o firmware.

## Ligado ao resto do projeto

- **Chamado 10** (`automacao_agricola`) — é o pedido que originou isto.
- **Chamado 7** (bug da ré) — o simulador reproduz: as chaves *Detectar ré* e
  *Esterçar de ré* são as mesmas do AOG, e desligar a primeira faz o rumo
  travar apontando para frente, com a seta vermelha no mapa.
- **Item 2.4 do chamado 10** (precisa de WAS?) — o controle de escorregamento
  do orbitrol responde. O achado até agora: **o erro acumula, não estabiliza**.
  Com 14% de escorregamento a diferença foi de 7,1° para 10,2° em poucos
  segundos, sem voltar. Se o orbitrol real escorregar, o encoder sozinho deriva
  ao longo do trabalho e o WAS se justifica. **Falta medir o escorregamento
  real** para saber se o caso se aplica.

## Pendências

- [ ] cronometrar o motor real batente a batente (fecha a maior incerteza)
- [ ] medir o escorregamento real do orbitrol no JD 5078
- [x] driver CH340 no PC do Filipe — instalado em 01/09, placa em **COM3**
- [x] gravar a ponte na placa (ela veio com o console manual)
- [ ] testar com o motor Keya no barramento, para a malha fechar com a placa
- [ ] devolver o console manual à placa antes de entregar ao Pedro
      (`pio run -e console -t upload`)
- [ ] decidir se o repo vira público para a equipe e entra no espelho central
