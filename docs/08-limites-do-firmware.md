# Dois limites duros do firmware, e por que a sintonia de Kp ainda não fecha

**Data:** 2026-09-09. Tudo medido no **simulado**, com o firmware real rodando
no PC. A placa não estava disponível.

Isto saiu de investigar por que a matriz de Kp de 08/09 deu ~1 m de erro em
quase toda célula. Não era o ganho. Eram dois limites do firmware que nada tem a
ver com controle, e um defeito meu no simulador.

---

## Limite 1 — atraso do heartbeat acima de ~30 ms e o engate vira cara ou coroa

O firmware desengata com `motor em erro` quando conta **4 heartbeats seguidos**
em que o motor se diz desabilitado enquanto o módulo está comandando PWM:

```cpp
if ((erro & 1) && ligado && pwm != 0) {
    if (++ciclosMotor >= 4) parar(FalhaDirecao::Motor);
} else ciclosMotor = 0;
```

No **engate** isso vira armadilha. O módulo manda ENABLE e começa a comandar PWM
no mesmo instante, mas os primeiros heartbeats a chegar foram tirados **antes**
do ENABLE — e dizem "desabilitado". Se o transporte atrasar perto de 4 períodos
de heartbeat (~96 ms), o módulo desengata sozinho, sem defeito nenhum embaixo.

Medido, 6 engates para cada atraso:

| atraso do heartbeat | engates que sobreviveram | pico de `ciclosMotor` |
|---|---|---|
| 0 ms | 6/6 | 2 |
| 20 ms | 6/6 | 3 |
| 30 ms | 6/6 | 3 |
| **40 ms** | **1/6** | 4 |
| 50 ms | 4/6 | 4 |
| 60 ms | 1/6 | 4 |
| **75 ms** | **0/6** | 4 |

Quando falha, falha sempre **180 ms depois do engate** — os 4 heartbeats.

O 50 ms sair melhor que o 40 é ruído de 6 repetições. O que a tabela diz de
firme é: **até 30 ms passa sempre; de 40 para cima é sorte.** Regime de sorte é
o pior para depurar no campo, porque o mesmo procedimento funciona e falha sem
nada mudar na tela.

### Por que isso importa

A latência do laço de **bancada** foi medida antes em **24 ms de mediana com
picos de 50 ms** — ou seja em cima da beirada. Isso explica engates que "às
vezes não pegam" na bancada.

**No trator não deve morder**: o CAN é direto e a latência é de ordem de 1 ms.
Mas quem testar na bancada precisa saber que está do lado ruim da margem.

### O que daria para melhorar no firmware

Zerar `ciclosMotor` na transição de "não comandando" para "comandando" — os
heartbeats anteriores ao ENABLE descrevem um passado que já não vale. Ou exigir
que o erro persista além da latência conhecida do transporte. **Não mexi no
firmware**; é decisão do Pedro.

---

## Limite 2 — motor mais rápido que ~7 voltas/s custa a referência

O detector de salto de encoder usa um teto de velocidade fixo:

```cpp
static constexpr int32_t CONTAGENS_SEGUNDO_MAX = 1800; // 5 voltas/s
const int32_t limite = 4 + CONTAGENS_SEGUNDO_MAX * intervalo / 1000;
if (!encoderAtualizar(encoder, bruto, -1, limite)) { ++saltos; parar(Encoder, true); }
```

Um delta maior que isso é lido como contagens perdidas — e essa é a **única**
falha que derruba a `referencia`. Derrubar a referência não é como as outras: o
módulo só volta com **reboot**, porque `referenciaPendente` já foi consumida.

Medido, com o piloto engatado e corrigindo:

| velocidade do motor a pleno | contagens/s | saltos | referência |
|---|---|---|---|
| 4 voltas/s | 1440 | 0 | mantida |
| 5 voltas/s | 1800 | 0 | mantida |
| 6 voltas/s | 2160 | 0 | mantida |
| **8 voltas/s** | 2880 | **2** | **perdida** |

O teto efetivo fica acima de 5 voltas/s nominais porque o `pwmAlto` é 180 de
255, ou seja o motor só chega a 71% do comando. Com `pwmAlto` cheio o teto cai
proporcionalmente.

### Por que isso importa

**A velocidade do motor a pleno PWM nunca foi medida.** As 4 voltas/s do
simulador são chute. Se o Keya real for mais rápido que ~7 voltas/s nessa
configuração, o módulo perde a referência **toda vez que corrigir com força** —
e no campo isso é o piloto morrendo no meio da lavoura, exigindo religar.

Medir é rápido e é o item que mais destrava coisa hoje:

1. Trator parado, motor no volante, console do Keya
   (`pio run -e console -t upload`).
2. Manda PWM cheio num sentido e **cronometra batente a batente**.
3. Anota as contagens percorridas — isso confirma o CPD por um caminho
   independente do GPS, e dá a velocidade em contagens por segundo.

---

## A sintonia de Kp continua sem resposta, e agora sei por quê

Com a calibragem certa (CPD 19) e o atraso dentro da faixa utilizável:

| Kp | 0 ms | 15 ms | 30 ms |
|---|---|---|---|
| 5 | 0,41 ~ | 0,22 ~ | 0,21 ~ |
| 10 | 0,18 | 0,07 | 0,17 |
| 20 | 0,04 | 0,02 | 0,02 |
| 40 | 0,02 | 0,02 | 0,00 |
| 80 | 0,00 | 0,00 | 0,00 |

Lido de fora, isso diz "quanto maior o ganho, melhor". E **Kp 126 dá 1 mm de
erro** no simulador.

**Esse mesmo Kp 126 não estabilizou no trator em 30/08.**

Então o simulador está aprovando um ganho já reprovado no campo, e um simulador
que faz isso é pior que inútil. **Não use esta tabela para configurar.** Falta
física, e ela precisa ficar visível.

### Hipótese testada e descartada: folga do orbitrol

A suspeita natural era folga — o trecho em que girar o motor não move a roda.
Foi implementada como parâmetro explícito (`folga`, em graus de roda, **nasce
desligada**) e varrida:

| folga | Kp 20 | Kp 126 |
|---|---|---|
| 0° | 0,041 m | 0,001 m |
| 1° | 0,095 m | 0,001 m |
| 2° | 0,152 m | 0,015 m |
| 4° | 0,233 m (oscila) | 0,100 m |

**Folga não explica.** Ela piora o ganho **baixo**, não o alto — faz sentido,
porque ganho alto atravessa a zona morta mais depressa. O parâmetro fica no
modelo porque é física real que faltava, mas não é o que estava faltando aqui.

### O que sobrou como suspeito

A **velocidade do motor** (o Limite 2 acima). É o único número grande do modelo
que nunca foi medido, e ele entra direto na resposta do laço. A varredura não
conseguiu isolá-lo porque acima de 7 voltas/s o firmware perde a referência
antes de dar tempo de oscilar — o Limite 2 mascara o efeito.

Ou seja: **a mesma medição destrava as duas coisas.** Cronometrar o motor batente
a batente responde se o Limite 2 é um risco real e dá o número que falta para a
sintonia valer alguma coisa.

---

## Um defeito meu, no caminho

A matriz de 08/09 também estava contaminada por um erro do simulador. O atraso
do heartbeat era uma fila; quando o atraso **diminuía** (75 → 0, que é o que a
matriz faz ao trocar de linha), os snapshots em voo ficavam órfãos e o firmware
recebia, logo depois de um heartbeat de 75 ms atrás, um fresquinho — 75 ms de
movimento num passo só. A 32°/s com CPD 19 são 45 contagens, acima do teto de 40,
e o módulo perdia a referência.

Corrigido esvaziando a fila quando a latência muda. Mas o fundo continua valendo,
e vale para o mundo real:

> **Latência que diminui com a roda girando custa a referência. Latência que
> aumenta, não.** Medido: `75 → 0` girando perde a referência; `0 → 75` girando
> não; qualquer mudança com a roda parada é segura.

Um transporte que engasga e depois recupera o atraso é indistinguível, para o
firmware, de contagens perdidas. Não há timestamp no heartbeat do Keya, então
ele só tem o próprio relógio para julgar.

---

## Como repetir

```bash
node testes/matriz-kp-atraso.js     # a matriz, na faixa utilizável de atraso
node testes/seguranca.js            # 9 cenários
```

Os roteiros de diagnóstico deste documento (varredura de atraso, de folga e de
velocidade do motor) foram feitos com scripts de uso único, não versionados. Os
números estão nas tabelas acima.
