# Antes de sair para o campo

Consolidado do que foi medido até 05/09, no formato de quem vai usar amanhã.
Não substitui o [plano de calibração](../../AgroPreciso/AgroPreciso/docs/guias/)
do Pedro — cobre o que **este simulador** aprendeu.

---

## 1. O que rodar antes de sair (≈ 5 minutos)

Na ordem. Cada um responde uma pergunta diferente.

```bash
# 1. logica pura, na propria placa — 17 checagens
cd AgroPreciso/firmware/autosteer_can_esp32
pio test -e esp32doit-devkit-v1 --upload-port COM3 --test-port COM3

# 2. REGRAVA a ponte (o pio test deixa o firmware de teste na placa)
pio run -e esp32doit-devkit-v1 -t upload --upload-port COM3

# 3. protocolo com a placa real — 10 checagens
cd ../..
$env:DOTNET_ROLL_FORWARD='LatestMajor'   # se o dotnet aqui for mais novo que o net8.0
dotnet run --project tools/aog_fake -- COM3

# 4. comportamento de sistema, sem placa — 6 cenarios
cd ../simulador_autosteer
node server/estresse-teste.js

# 5. seguranca com o trator andando — 8 cenarios
node testes/seguranca.js simulado
```

⚠️ **Feche o AgIO antes de tudo** — ele segura a porta serial.

## 2. O ajuste que os testes recomendam

### Kp — a tabela antiga foi **invalidada em 07/09**

> ⚠️ **Os números abaixo foram medidos com o simulador calibrado errado.**
> A matriz rodava com CPD 100, que é o padrão de tela do AgOpenGPS e **não** a
> máquina. O batente que o Pedro mediu no JD 5078 em 05/09 (760 contagens do
> centro, ~40° de roda) implica CPD ≈ **19**. Com CPD 19 o mesmo PWM move a roda
> **5,3x mais rápido** em graus por segundo.
>
> Planta mais rápida desestabiliza com ganho **menor**. Ou seja: a recomendação
> "Kp 20" saiu de uma máquina muito mais mansa que a real, e o Kp seguro no
> trator provavelmente está **abaixo** disso.

Tabela antiga, mantida só como registro (**não use para configurar**):

| Kp | sem atraso | 40 ms | 75 ms |
|---|---|---|---|
| 20 | 10 cm | 9 cm | 4 cm |
| 40 | 2 cm | 1,10 m ✗ | 47 cm |
| 126 | 48 cm ✗ | 1,03 m ✗ | 1,14 m ✗ |

O único item que **sobrevive**: **Kp 126 não estabiliza em condição nenhuma**, e
era o valor gravado em 30/08. Com a planta mais rápida ele fica pior ainda.

### O que ainda falta para dar um número confiável

A velocidade do motor a pleno PWM **nunca foi medida**. Ela entra direto na
conta e hoje é chute (4 voltas/s no simulador). Enquanto ela for chute, qualquer
matriz de Kp daqui é ordem de grandeza, não recomendação.

Medir é rápido e vale mais que um dia de simulação:

1. Trator parado, motor no volante, console do Keya
   (`pio run -e console -t upload`).
2. Manda PWM cheio num sentido e **cronometra batente a batente**.
3. Anota também as contagens percorridas — isso confirma o CPD por um caminho
   independente do GPS.

Com esse número, `node testes/matriz-kp-atraso.js` passa a valer, e ele já roda
com CPD 19.

### Os outros

| Ajuste | Valor | Por quê |
|---|---|---|
| Max Steer Speed | 10 km/h | trabalho é a 5-8; o limite é para o acelerador sem pensar |
| Min Steer Speed | 1 km/h | evita esterçar parado, que castiga direção e solo |
| RTK Kill Autosteer | **ligado** | sem Fix o erro vira metros e o piloto segue confiante |
| Side Hill Comp | 0 | só depois que CPD e Invert Roll estiverem calibrados |
| Max Steer Angle | menor batente − 3° | com o valor cheio, o motor força o fim de curso e o override dispara na cabeceira |

## 3. Se o piloto não engatar: faça isto ANTES de qualquer diagnóstico

**1. Olhe o campo PWM na tela Steer Settings.** Com o motor parado ele não é
PWM: é o **código do motivo**. A tabela está na
[nota da trava](05-trava-de-seguranca.md#a-terceira-recomendação-virou-código).
O mais comum na partida é **1 — sem zero de partida**.

**2. Se o código for 1: pare o trator.** Desde 07/09 o módulo centra sozinho,
mas só com o trator **parado**, piloto desligado e o motor respondendo. Se a
placa reiniciou andando, ela espera. Parar resolve — não precisa de terminal.

**3. Se não for isso, desligue o piloto na tela e ligue de novo.** A trava de
segurança agora cai sozinha depois de 250 ms com o piloto desligado, então isso
é bem menos provável que era em 05/09 — mas continua sendo o primeiro
movimento, porque custa dois segundos.

> Até 06/09 a trava só soltava na borda de descida do pedido, e um ciclo
> desliga/liga era **obrigatório**. Foi isso que derrubou o AogFake em 01/09.
> O commit `fc50b61` de 07/09 mudou isso.

## 4. O que está provado

| | Onde foi medido |
|---|---|
| o cão de guarda do AOG solta em **1000 ms exatos** | placa |
| o cão de guarda do motor solta em ~1000 ms | placa e simulado |
| a mão no volante desengata **e continua solto** | placa e simulado |
| o parser se recupera de lixo no fio em **2 a 3 quadros** (220-330 ms) | placa |
| o encoder atravessa o estouro de 16 bits sem perder a conta | placa e simulado |
| o encoder **não deriva**: 8 giros batente a batente, variação 0,00° | placa e simulado |
| forçar o batente sobe a corrente e desengata sozinho | simulado |
| o firmware compilado no PC se comporta como o do ESP32 | espelho, 20/21 |

Os 8 cenários de segurança passam **na placa real** (`node testes/seguranca.js bancada`)
e no simulado. Os 6 do `estresse-teste.js` do Pedro também.

## 5. O que continua SEM cobertura

Honestidade sobre o que o simulador não alcança:

- **O limiar do override sob carga.** É o item de segurança em aberto, e o
  próprio plano de calibração marca como bloqueante. Precisa do motor no trator,
  com o peso da direção. Nem o simulador nem o AogFake chegam lá. **§2.5 do
  plano de calibração, no pátio, antes de qualquer teste em movimento.**
- **O barramento CAN físico.** No modo bancada os quadros nascem e morrem dentro
  do ESP32. O transceptor e a fiação não entram — e o log de 01/09 mostrou falha
  de TX sistemática, que aponta para motor desligado, CAN-H/CAN-L trocados ou
  **terra comum ausente** (obrigatório, não opcional).
- **Motor montado ao contrário não é detectado — e é o mais perigoso da lista.**
  Medido na placa: o firmware acha que está em **−28,5°** enquanto a roda está
  em **+12,1°**. Divergência de 40°, e **nada acusa**: sem WAS não existe fonte
  independente para comparar. No campo isso é o piloto esterçando para o lado
  errado com confiança.

  > **Conferir o sentido no Free Drive antes de qualquer outra coisa**, todo dia,
  > e principalmente depois de trocar de trator. É o passo 1.1 do plano de
  > calibração, e o motivo dele estar em primeiro lugar.
- **A deriva do encoder no orbitrol real.** Aqui o escorregamento é um controle;
  quanto ele escorrega de verdade, só o campo diz.

## 6. A pergunta do WAS, em uma linha

Com escorregamento do orbitrol, **o erro acumula, não estabiliza** — medimos 14%
de escorregamento levando a diferença de 7,1° para 10,2° em poucos segundos, sem
voltar. Se o orbitrol real escorregar, o encoder sozinho deriva ao longo do
trabalho. **Medir o escorregamento real é o que fecha a decisão do WAS.**
