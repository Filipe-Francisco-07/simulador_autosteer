# Modo bancada: o ESP32 traduzindo de verdade

Como a malha passou a fechar com a placa no meio, sem o motor Keya na mesa.

---

## O problema

O módulo conversa com o motor por **CAN**, um barramento físico. O PC não tem
CAN. Então, com a placa na mão mas sem o motor:

- o firmware nunca recebe heartbeat
- o encoder nunca inicia, o ângulo fica em **zero**
- o piloto não esterça

Sobrava testar só a conversa com o AgOpenGPS — que o
[AogFake do Pedro](../../AgroPreciso/AgroPreciso/tools/aog_fake/) já cobre, com
10 asserções, melhor do que este simulador faria.

## A saída

O ESP32 consegue **receber os próprios quadros CAN**: modo `TWAI_MODE_NO_ACK`
com `self reception`. É a mesma técnica do
[`can_selftest.cpp`](../../AgroPreciso/AgroPreciso/firmware/autosteer_can_esp32/src/can_selftest.cpp),
já validada 16/16 nesta placa pelo Pedro.

Então:

```
   PC (motor Keya de mentira)                    ESP32 (tradutor DE VERDADE)
   ─────────────────────────                     ──────────────────────────
   heartbeat ──── PGN 240 pela USB ────►  injeta no próprio barramento CAN
                                                        │
                                          a lógica de tradução recebe como
                                          se viesse do motor: estima o ângulo,
                                          roda o PID, decide o comando
                                                        │
   motor obedece ◄─── PGN 241 (eco) ────  transmite o comando ao motor
```

**A malha fecha com o firmware rodando no ESP32**: tipos de inteiro reais,
`millis()` real, buffer serial real, o parser de verdade. Só o motor é
simulado.

## O firmware de bancada

Em [`firmware_bancada/`](../firmware_bancada/). Ele **não tem cópia da lógica**:
inclui o `main.cpp` de produção do AgroPreciso e muda só três coisas.

| O que muda | Por quê |
|---|---|
| TWAI sobe em `NO_ACK` | para funcionar sem ninguém no barramento |
| a `Serial` passa por um filtro | separa o PGN 240 (injeção) do resto, sem tocar no firmware |
| `twai_transmit` é espionado | ecoa o comando no PGN 241, para o PC saber o que o motor receberia |

As três são feitas por `#define` **antes** do `#include "main.cpp"`. A lógica de
ângulo, PID, override e trava é byte a byte a de produção.

### Gravar

```bash
cd firmware_bancada
pio run -e bancada -t upload --upload-port COM3
```

### Voltar ao firmware de produção

⚠️ **Obrigatório antes de levar a placa ao trator** — o de bancada sobe em
`NO_ACK`, que não é o modo certo para conversar com o motor de verdade.

```bash
cd ../AgroPreciso/AgroPreciso/firmware/autosteer_can_esp32
pio run -e esp32doit-devkit-v1 -t upload --upload-port COM3
```

### Devolver o console manual ao Pedro

A placa chegou com ele gravado:

```bash
pio run -e console -t upload --upload-port COM3
```

## Como usar

Conecte a placa pelo painel, como sempre. O simulador **reconhece sozinho** o
firmware de bancada — ele se revela ao ecoar o primeiro comando CAN — e a faixa
do topo passa a dizer **"malha fechada"**, em verde.

Daí em diante é igual ao modo simulado: dirigir, marcar A e B, engatar. A
diferença é que quem traduz é a placa.

## Por que o PWM na tela vinha errado

O byte 12 do PGN 253 **não é só o PWM**. O firmware faz:

```cpp
if (pwm == 0) return cpdEmUso;   // parado? reporta o CPD
```

Foi decisão do Pedro depois de 30/08 (o CPD errado não aparecia em lugar
nenhum). Mas quem lê sem saber vê "PWM 100" com o motor parado — e foi
exatamente o que aconteceu aqui: a bancada **parecia estável** porque o valor
lido era o CPD, constante.

No modo bancada o simulador usa o **comando CAN ecoado** para saber o PWM de
verdade, com sinal. Com o número certo, a oscilação apareceu — e foi ela que
levou à descoberta sobre o Kp (ver [03-resultados.md](03-resultados.md)).

## O que este modo ainda NÃO prova

- **O barramento CAN físico.** Os quadros nascem e morrem dentro do ESP32; o
  transceptor SN65HVD230 e a fiação não entram.
- **O motor de verdade.** Corrente, inércia, atrito e o override sob carga
  continuam sem cobertura — e o override é o item de segurança em aberto.
- **A latência é da mesa.** A volta pela USB custa ~25 ms, com picos de 50. No
  trator o módulo fala CAN direto com o motor e essa espera não existe.
