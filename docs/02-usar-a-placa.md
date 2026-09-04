# Usar o ESP32 de verdade

**Criado:** 2026-09-01. Placa emprestada pelo Pedro (item 3.1 do chamado 10).

O simulador tem dois modos. Este documento é sobre o segundo: falar com o
módulo real pela USB, em vez do firmware compilado no PC.

---

## O que já foi feito neste PC (01/09)

- driver CH340 instalado (`CH341SER.EXE` da WCH, assinatura conferida)
- PlatformIO Core 6.1.19 instalado, com a toolchain do ESP32
- a placa apareceu como **COM3**
- **a placa estava com o firmware errado** — ver abaixo
- ponte gravada e conversando com o simulador

## Cuidado: qual firmware está gravado?

A placa do Pedro chegou com o **console manual** (`console_keya.cpp`), não com
a ponte. Os dois moram no mesmo repositório e são ambientes diferentes do
PlatformIO — fácil de confundir, e o sintoma engana: a porta abre, o LED
acende, e simplesmente **nenhum PGN chega**, porque aquele firmware não fala
PGN. Sem o banner, isso parece defeito de comunicação.

| Ambiente | Arquivo | Baud | Para que serve |
|---|---|---|---|
| `esp32doit-devkit-v1` | `main.cpp` | 38400 | **a ponte** — é o que o simulador testa |
| `console` | `console_keya.cpp` | 115200 | comandar o motor pelo teclado, sem malha |
| `selftest` | `can_selftest.cpp` | 115200 | testar o CAN sem o motor |

**Gravar a ponte:**

```bash
cd AgroPreciso/firmware/autosteer_can_esp32
python -m platformio run -e esp32doit-devkit-v1 -t upload --upload-port COM3
```

**Devolver o console para o Pedro** (é só trocar o ambiente):

```bash
python -m platformio run -e console -t upload --upload-port COM3
```

O simulador reinicia a placa ao conectar justamente para pegar o banner, que
diz o nome do firmware **e a data de compilação**. É a resposta rápida para
"está atualizado?" sem regravar nada.

## Antes de tudo: o driver

O ESP32 do módulo usa o conversor **CH340** (`VID 1A86 / PID 7523`). O Windows
não traz esse driver de fábrica — sem ele a placa aparece no Gerenciador de
Dispositivos como **"USB Serial" com erro (código 28)** e nenhuma porta COM
surge.

**Instalar (precisa de administrador):**

1. Abrir o **Gerenciador de Dispositivos** (tecla Windows, digitar
   "gerenciador de dispositivos")
2. Achar **USB Serial** com o triângulo amarelo, em "Outros dispositivos"
3. Botão direito → **Atualizar driver** → *Pesquisar drivers automaticamente*
4. O Windows Update tem o CH340 desde 2019; ele baixa e instala sozinho

Se o Windows não achar, baixar o `CH341SER` no site da WCH
(<https://www.wch-ic.com/downloads/CH341SER_EXE.html>) e rodar o instalador.

**Conferir se deu certo:** a placa passa a aparecer como `COM3`, `COM5` ou
parecido. No simulador, a porta aparece marcada como *(parece o módulo)*,
porque ele reconhece o par VID/PID.

## Conectar

Na faixa **Firmware rodando em**, no alto da tela:

1. **Procurar** — lista as portas
2. escolher a que diz *(parece o módulo)*
3. deixar em **38400 baud** (o firmware fixa isso em `BAUD_PGN`)
4. **Usar a placa**

Se a porta abrir e o módulo estiver do outro lado, o banner do firmware aparece
logo abaixo ("AgroPreciso — ponte AOG <-> Keya"), com a data de compilação. É a
forma de saber **qual firmware está gravado** sem regravar.

### Se aparecer "a porta abriu mas nada chega"

Três causas, nessa ordem de probabilidade:

1. **Porta errada.** Os CH340 do projeto não têm número de série, então o
   Windows dá o COM pela posição física do conector — trocar a tomada USB troca
   o número. Tentar as outras portas da lista.
2. **Baud errado.** O firmware do módulo de direção fala **38400**. O 115200 é
   o do rover.
3. **Outro firmware gravado.** Foi o que aconteceu aqui: o console manual
   estava na placa e não fala PGN nenhum. O banner denuncia — ver a seção
   acima.

## O que dá para testar com a placa

- se ela responde o **PGN 253**, e em que cadência (o firmware manda a 10 Hz)
- se ela responde o **hello do AgIO** (é o que a faz aparecer como *Found*)
- se o **baud aguenta** o tráfego sem perder quadro
- o **tempo real** do ESP32, com o jitter da USB que o modo simulado não tem
- **qual firmware está gravado**, pelo banner

## O que NÃO dá para testar assim

**O motor Keya não está no barramento.** A placa fala CAN por hardware, num
barramento que o PC não enxerga. Sem o motor:

- o firmware nunca recebe heartbeat → `keyaVisto` fica falso
- o encoder nunca inicia → o ângulo reportado fica em **zero**
- o piloto não esterça, e o trator na tela não obedece

Isso **não é defeito**: é o arranjo. Para a malha fechar com a placa seria
preciso o motor Keya ligado nela (ou um adaptador CAN no PC fazendo o papel
dele). Enquanto isso, a divisão é:

| Pergunta | Onde responder |
|---|---|
| a lógica do firmware está certa? | modo simulado |
| ele conversa de verdade com o AOG? | modo placa |
| a malha inteira funciona no fio? | placa **+ motor**, ainda não feito |

## Voltar ao simulado

Botão **Voltar ao simulado** na mesma faixa. A porta é liberada — importante se
você for abrir o AgIO ou o `pio device monitor` depois, porque uma porta serial
só abre uma vez.
