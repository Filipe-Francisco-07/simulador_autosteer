# Resultados dos testes

O que foi medido, com número. Atualizado conforme os testes rodam.

**Placa:** ESP32 do Pedro, COM3, firmware `main.cpp` compilado em 01/09 21:16.

---

## 1. O espelho: o simulador merece confiança?

O modo simulado tem uma fraqueza de nascença: o firmware é compilado para x86,
não para o ESP32. Tipos de inteiro e saturação **poderiam** diferir — e o
defeito que custou o teste de campo de 30/08 era exatamente um estouro de
`int16`. Um simulador que erre nisso não avisa: mente calado.

O **modo espelho** manda o mesmo estímulo nos dois firmwares ao mesmo tempo e
compara o PGN 253 que cada um devolve.

### Roteiro normal — 20/20 iguais

Cobre engate, PID com dois ganhos, zona morta, saturação nos dois sentidos,
offset grande, cão de guarda e **CPD 1 e 2** (a causa raiz de 30/08).

**Nenhuma divergência.** O firmware compilado no PC se comporta igual ao
gravado no ESP32, inclusive nos extremos que quebraram em campo.

### Roteiro de estresse — 24 a 25 de 25

Quadro com CRC errado, tamanho mentiroso, PGN desconhecido, só cabeçalho, lixo
puro, dois quadros colados, CPD 0, alvo no extremo do `int16`, `pwmMinimo`
maior que `pwmAlto`, ganho 0 e 255, rajada de 30 quadros, engata/desengata 20
vezes seguidas.

> **Conclusão:** o modo simulado pode ser usado para julgar o comportamento do
> firmware. Isso não era garantido antes; agora é medido.

### A variabilidade que sobra, e por que ela não muda a conclusão

Repetindo as rodadas, o placar oscila (17 a 21 de 21 no roteiro normal; 24 a 25
de 25 no de estresse). **As divergências são sempre do mesmo tipo**: a placa
reporta `100` — o CPD de repouso, ou seja, ela **não estava acionando naquele
instante** — enquanto o simulado reporta um PWM.

Não é diferença de cálculo: é diferença de *momento*. Duas causas conhecidas,
as duas do arranjo:

1. **A trava de segurança** herdada de um teste anterior (§ [05](05-trava-de-seguranca.md)).
   O roteiro passou a começar soltando o pedido de engate, o que reduziu muito
   — mas não elimina, porque a trava pode armar durante a própria rodada.
2. **Latência da USB.** A placa responde ~25 ms depois; se o relatório dela sai
   no meio da mudança, a leitura pega o estado anterior.

Nenhuma divergência até hoje mostrou os dois firmwares **calculando coisas
diferentes** para o mesmo estado. Enquanto for assim, a conclusão se sustenta —
e vale continuar rodando, porque é exatamente esse o caso que o espelho existe
para pegar.

## 2. Cão de guarda: 1000 ms nos dois

| | Larga em |
|---|---|
| placa (ESP32) | **1000 ms**, exato |
| simulado | ~950 ms |
| firmware manda | 1000 ms |

A placa reporta a **10,0 Hz**, como o código pede.

## 3. Recuperação depois de lixo no fio

O caso realista: cabo mal encaixado, ruído do trator, o AgIO abrindo a porta no
meio de um quadro. Se o parser travar desalinhado, o piloto para de obedecer
sem ninguém entender por quê.

| Lixo enviado | Volta a obedecer em |
|---|---|
| meio quadro (7 bytes) | 325 ms (3 quadros) |
| cabeçalho solto (`80 81`) | 330 ms (3 quadros) |
| tamanho mentiroso (diz 200) | 219 ms (2 quadros) |
| 200 bytes aleatórios | 218 ms (2 quadros) |
| `0x80` repetido 50 vezes | 217 ms (2 quadros) |
| quadro cortado antes do CRC | 326 ms (3 quadros) |

**O parser ressincroniza sempre, em 2 a 3 quadros.** Nenhum caso travou. É um
bom resultado para o campo, e vale para o firmware que está gravado hoje.

## 4. Rajada: um limite real do hardware

Mandar dezenas de quadros colados às vezes faz a placa deixar de obedecer o
último. O simulado nunca falha nisso, porque a fila dele é ilimitada — é a
única diferença conhecida entre os dois.

**Não é caso realista:** o AgOpenGPS manda a 10 Hz espaçado, nunca em rajada.
Fica registrado como limite conhecido, sem prioridade.

## 5. Bancada: o ESP32 traduzindo de verdade

Desde 02/09 existe um terceiro arranjo. O firmware **de produção** roda na
placa e o PC faz o papel do motor Keya: manda o heartbeat pela USB, o ESP32
injeta no próprio barramento CAN (modo `NO_ACK` + self reception) e a lógica de
tradução o recebe como se viesse do motor. Detalhes em
[04-modo-bancada.md](04-modo-bancada.md).

**A malha fecha com o tradutor de verdade no meio** — tipos de inteiro reais,
`millis()` real, buffer serial real. Só o motor é de mentira.

| | erro médio na passada |
|---|---|
| simulado (tudo no PC) | 4 cm |
| **bancada (ESP32 real)** | oscila — ver abaixo |

## 6. Quanto atraso a malha aguenta

Na bancada o trator passou a oscilar. Antes de culpar o firmware, medimos a
volta da malha: **mediana 24 ms, picos de 50 ms** — duas travessias de USB que
no trator não existem (lá o módulo fala CAN direto com o motor).

Para separar arranjo de defeito, o simulador ganhou um atraso artificial no
caminho do motor. Erro médio nos últimos 10 s:

| Kp | 0 ms | 40 ms | 75 ms |
|---|---|---|---|
| **20** | 10 cm | 9 cm | **4 cm** — firme em tudo |
| **40** | 2 cm | **1,10 m** ✗ | 47 cm |
| **126** | **48 cm** ✗ | 1,03 m ✗ | 1,14 m ✗ |

### O que isso diz

1. **A oscilação da bancada é do arranjo, não do firmware.** Com Kp 40 a malha
   quebra em 40 ms, e a bancada vive na borda dos 25-50 ms. No trator esse
   atraso não existe.
2. **Kp 126 não estabiliza nem com atraso zero.** Confirma com número o alerta
   que já estava na
   [análise de 30/08](../../AgroPreciso/AgroPreciso/teste_campo/analise-2026-08-30.md):
   *"o Kp 126 é perigoso agora"*. Era 126 que estava gravado naquele dia.
3. **Kp 20 é o valor robusto.** Firme mesmo com 75 ms de atraso. Kp 40 dá o
   melhor acabamento (2 cm) mas não perdoa atraso nenhum.

> **Para o próximo teste de campo:** começar em **Kp 20**. Subir só depois que a
> linha estiver limpa, e um passo por vez.

## 8. Rotina de partida: a âncora do offset funciona

Sem WAS o ângulo é relativo ao boot, mas o AOG **guarda** o `wasOffset` entre
sessões e o reenvia na partida — apontando para uma origem que não existe mais.
Em 30/08 o valor salvo era **283** e o ângulo nascia a dezenas de graus do real,
em silêncio. O firmware ganhou uma âncora (`ancorarOffset`).

Medido com o valor real daquele dia, no simulado **e na placa**:

| Passo | Resultado |
|---|---|
| offset 283 chega na partida | ângulo nasce em **0,00°** — a âncora pega |
| gira o volante até o batente | estimado 40,00° · roda 40,00° — acompanha |
| aperta "zerar rodas" com a roda torta | zera ali mesmo |

O terceiro passo é o lembrete de por que a rotina manda zerar com as **rodas
retas**: zerar torto ensina ao módulo que torto é o zero.

## 7. A ré (chamado 7) — reproduzida nos dois arranjos

Três combinações das duas chaves do AgOpenGPS, medidas no simulado **e na placa**
(resultado idêntico):

| Detectar ré | Esterçar de ré | O que acontece andando para trás |
|---|---|---|
| ligado | desligado *(padrão)* | o AOG detecta e **o piloto solta** — seguro |
| ligado | ligado | detecta e **continua esterçando** — escolha do operador |
| **desligado** | desligado | **não detecta**: o rumo trava apontando para frente e **o piloto continua acionando** |

A terceira linha é o chamado 7. O sintoma não é o piloto desengatar: é ele
**continuar trabalhando com o rumo invertido**, esterçando para o lado errado
com confiança.

> Confirma o que já estava na
> [referência de configurações](../../AgroPreciso/AgroPreciso/docs/arquitetura/agopengps-configuracoes-completo.md):
> é configuração, não código. `node testes/re.js bancada` reproduz.

---

## Defeitos encontrados — e de quem eram

Nenhum defeito novo no firmware até aqui. **Os achados foram todos do lado do
teste**, e cada um teria virado uma acusação falsa contra o firmware:

| # | Sintoma | Onde estava | Correção |
|---|---|---|---|
| 1 | motor voava para o batente | simulador: `(alta << 16) \| baixa` já devolve int32 com sinal em JS, e eu convertia de novo | usar o valor direto |
| 2 | ângulo divergia sem limite | simulador: encoder contava com a roda parada no batente | no fim de curso o motor trava junto, e a corrente sobe |
| 3 | trator fugia da linha | simulador: pure pursuit inverte o sinal com erro grande | troca por Stanley |
| 4 | não saía da marcha ré | simulador: troca recusada em silêncio enquanto deslizava | freia e engata |
| 5 | **cão de guarda não disparava** | simulador: o relógio corria **1,37x mais devagar** que o mundo, porque eu avançava 20 ms fixos por tique em vez do tempo real | avançar o tempo decorrido de verdade |
| 6 | divergências aleatórias no espelho | método: eu mandava o estímulo e ficava calado, então o cão de guarda disparava no meio da comparação | o espelho repete o comando, como o AOG de verdade faz |
| 7 | "a placa oscila entre 180 e 0" | script de medição: eu reprocessava o buffer inteiro a cada chegada, e quadros antigos reapareciam | consumir o buffer a cada quadro lido |
| 8 | a bancada parecia estável com PWM 100 fixo | leitura: o byte 12 do PGN 253 **vira o CPD quando o PWM é zero** (`byteDiagnostico`, decisão do Pedro em 30/08). Eu lia como PWM | na bancada, ler o PWM do comando CAN ecoado |
| 9 | **"zerar rodas" não funcionava na placa** | firmware de bancada: a fila do filtro serial só era reciclada quando esvaziava **por completo**. Sobrando um byte, ela enchia até o teto e passava a **descartar PGN em silêncio** | abrir espaço antes de escrever, empurrando o que falta ler para o início |
| 10 | divergências do espelho que mudavam de rodada | método: o espelho desligava o motor "para ser justo", mas o cão de guarda do heartbeat só age em quem **já viu** o motor — e esse histórico diferia entre a placa e o processo recém-reiniciado | alimentar os dois firmwares com o mesmo heartbeat |

O nº 9 é o mais instrutivo do dia: o sintoma era **o operador apertar "zerar
rodas" e nada acontecer**, sem nenhum aviso. Um comando descartado em silêncio
é o pior tipo de falha — e ela estava na minha ponte, não no firmware. Só
apareceu porque o mesmo teste rodava nos dois lados e um deles discordou.

O **nº 5 é o mais sério**, e só apareceu porque havia hardware do lado para
comparar: sem a placa, o simulador teria continuado dando prazos 37% mais
folgados sem ninguém desconfiar. O **nº 7 quase virou um bug reportado no
firmware** que não existia.

> A lição que vale registrar: **um simulador errado não avisa que está errado —
> ele acusa o firmware.** Por isso o espelho existe.

O nº 8 merece nota: com o PWM lido errado, a bancada **parecia estável**. Só
depois de ler o valor certo é que a oscilação apareceu — e foi ela que levou à
medição de atraso e à descoberta sobre o Kp. Um número mal interpretado
escondeu o achado mais útil da sessão.
