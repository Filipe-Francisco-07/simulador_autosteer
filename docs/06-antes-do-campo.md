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

# 5. a malha fecha nos tres alvos — precisa do servidor NAO estar rodando
node server/malha-teste.js

# --- os de baixo precisam do servidor de pe: npm run dev noutro terminal ---

# 6. seguranca com o trator andando — 9 cenarios
node testes/seguranca.js simulado

# 7. a rotina de partida e o offset herdado  <<< FALHA HOJE, DE PROPOSITO
node testes/partida.js

# 8. o metodo de calibragem por GPS acerta a verdade conhecida — nao usa servidor
node testes/calibragem.js

# 9. o modulo aparece no AgIO? — nao usa servidor
node testes/descoberta.js
```

⚠️ **Feche o AgIO antes de tudo** — ele segura a porta serial.

### O que cada um cobre, e o que não roda hoje

| roteiro | estado em 09/09 | precisa da placa |
|---|---|---|
| `server/estresse-teste.js` | 6 de 6 | não |
| `server/malha-teste.js` | 3 de 3 | não |
| `testes/seguranca.js simulado` | 9 de 9 | não |
| `testes/calibragem.js` | 9 de 9 | não |
| `testes/descoberta.js` | 5 de 5 | não |
| `testes/corrigir-cpd.js` | passa | não |
| `testes/matriz-kp-atraso.js` | roda, **não conclui** | não |
| `testes/partida.js` | **FALHA** — é o defeito do offset | não |
| `testes/trava-presa.js simulado` | roda, informativo | não |
| `testes/re.js` | roda, informativo | não |
| `testes/latencia.js` | **não roda** | sim (COM3) |
| espelho / bancada | **não roda** | sim |

O `partida.js` falhar é intencional: ele agora falha de verdade no defeito do
offset herdado ([Limite 3](08-limites-do-firmware.md)). Quando isso for
resolvido no firmware, ele volta a passar sozinho.

> **Nada foi rodado na placa desde 06/09.** Toda a bateria acima é simulado. A
> reescrita do firmware de 07/09 e as correções de 08 e 09/09 não passaram por
> hardware nenhum.

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

Medir é rápido e vale mais que um dia de simulação — e desde 09/09 essa medição
destrava **duas** coisas: além da sintonia, ela diz se o motor real passa do
teto de velocidade acima do qual o firmware perde a referência
(~7 voltas/s com `pwmAlto` 180). Perder a referência no campo exige religar a
placa. Ver [08-limites-do-firmware.md](08-limites-do-firmware.md).

Medir é rápido e vale mais que um dia de simulação:

1. Trator parado, motor no volante, console do Keya
   (`pio run -e console -t upload`).
2. Manda PWM cheio num sentido e **cronometra batente a batente**.
3. Anota também as contagens percorridas — isso confirma o CPD por um caminho
   independente do GPS.

Com esse número, `node testes/matriz-kp-atraso.js` passa a valer, e ele já roda
com CPD 19.

> **A primeira rodada com CPD 19 (08/09) foi descartada, não publicada** — as
> células mediam um trator com o piloto solto. A causa foi encontrada em 09/09 e
> são dois tetos do firmware mais um defeito meu no simulador; está tudo em
> [08-limites-do-firmware.md](08-limites-do-firmware.md).
>
> **A matriz continua sem resposta, mas agora por um motivo conhecido.** Com a
> calibragem certa ela diz "quanto maior o ganho, melhor" e aprova **Kp 126 com
> 1 mm de erro** — o mesmo Kp que não estabilizou no trator em 30/08. Falta
> física no modelo. **Não configure Kp por ela.**

### Os outros

| Ajuste | Valor | Por quê |
|---|---|---|
| Max Steer Speed | 10 km/h | trabalho é a 5-8; o limite é para o acelerador sem pensar |
| Min Steer Speed | 1 km/h | evita esterçar parado, que castiga direção e solo |
| RTK Kill Autosteer | **ligado** | sem Fix o erro vira metros e o piloto segue confiante |
| Side Hill Comp | 0 | só depois que CPD e Invert Roll estiverem calibrados |
| Max Steer Angle | menor batente − 3° | com o valor cheio, o motor força o fim de curso e o override dispara na cabeceira |

## 3. Se o piloto não engatar: faça isto ANTES de qualquer diagnóstico

**0. Antes de tudo: zere o Steer Zero / WAS offset na tela do AgOpenGPS.**
Um offset guardado de outra sessão desloca o zero do módulo em `offset/CPD`
graus **em silêncio** — com o valor real de 30/08 (283) e CPD 19 são **14,89°**
de erro sem nada na tela. É o defeito que perdeu aquele dia de campo e ele
voltou na reescrita de 07/09. Detalhes e evidência em
[08-limites-do-firmware.md](08-limites-do-firmware.md#limite-3--o-offset-guardado-pelo-agopengps-volta-a-deslocar-o-zero).
Confira na tela que o ângulo nasce em zero com as rodas retas.

**1. Olhe o campo PWM na tela Steer Settings.** Com o motor parado ele não é
PWM: é o **código do motivo**. A tabela está na
[nota da trava](05-trava-de-seguranca.md#a-terceira-recomendação-virou-código).
O mais comum na partida é **1 — sem zero de partida**.

**2. Se o código for 1: pare o trator.** Desde 07/09 o módulo centra sozinho,
mas só com o trator **parado**, piloto desligado e o motor respondendo. Se a
placa reiniciou andando, ela espera. Parar resolve — não precisa de terminal.

**3. Se não for isso, desligue o piloto na tela e ligue de novo.** Continua
obrigatório, e desde 07/09 exige um pouco mais: **250 ms** com o piloto
desligado **e** o módulo saudável (heartbeat fresco, referência de pé, limites
válidos, motor sem erro, corrente baixa). Desligar e religar rápido demais pode
não soltar — conte até dois.

> Escrevi em 07/09 que esse ciclo tinha deixado de ser necessário.
> **Estava errado**, e a medição de 09/09 mostra o contrário. A correção e a
> comparação entre os dois firmwares estão em
> [05-trava-de-seguranca.md](05-trava-de-seguranca.md). O firmware de 07/09
> ficou **mais** exigente aqui, não menos.

## 4. O que está provado

| | Onde foi medido |
|---|---|
| o cão de guarda do AOG solta em **1000 ms exatos** | placa |
| o cão de guarda do motor solta em ~1000 ms | placa e simulado |
| a mão no volante desengata **e continua solto** | placa e simulado — mas ver a ressalva abaixo |
| o parser se recupera de lixo no fio em **2 a 3 quadros** (220-330 ms) | placa |
| o encoder atravessa o estouro de 16 bits sem perder a conta | placa e simulado |
| o encoder **não deriva**: 8 giros batente a batente, variação 0,00° | placa e simulado |
| forçar o batente sobe a corrente e desengata sozinho | simulado |
| o firmware compilado no PC se comporta como o do ESP32 | espelho, 20/21 |

> ⚠️ **A linha da mão no volante vale menos do que parece.** A medida na placa
> foi feita com o firmware anterior a 07/09 e com a versão do cenário que não
> era um override de verdade (o simulador proibia girar o volante engatado, e a
> mão não freava o motor). O comportamento correto foi reproduzido em 08/09 no
> **simulado**; na placa ainda não, porque ela não estava disponível. Refazer
> `node testes/seguranca.js bancada` quando o ESP32 voltar.

Os cenários de segurança passavam **na placa real**
(`node testes/seguranca.js bancada`) com o firmware de até 06/09. Depois da
reescrita do firmware em 07/09 e das correções de 08/09, só há resultado no
**simulado** — a placa não foi religada desde então. Os 6 do
`estresse-teste.js` do Pedro também são de antes.

## 5. O que continua SEM cobertura

Honestidade sobre o que o simulador não alcança:

- **O limiar do override sob carga.** É o item de segurança em aberto, e o
  próprio plano de calibração marca como bloqueante. Precisa do motor no trator,
  com o peso da direção. Nem o simulador nem o AogFake chegam lá. **§2.5 do
  plano de calibração, no pátio, antes de qualquer teste em movimento.**

  > **Corrigido em 08/09 o que o simulador conseguia dizer sobre isso — e não
  > era nada.** Até então o simulador **proibia girar o volante com o piloto
  > engatado**, que é exatamente o que override significa, e a mão no volante
  > não oferecia resistência nenhuma ao motor: só trocava uma leitura de
  > corrente. O cenário "mão no volante" da suíte passava por acidente, porque
  > a calibragem errada (CPD 100) deixava a planta tão lenta que o PWM ficava
  > alto o tempo todo e a corrente subia por tabela. Corrigida a calibragem, o
  > módulo passou a chegar na linha com PWM zero, a mão parada deixou de
  > encontrar qualquer coisa, e o caso quebrou — foi assim que o defeito
  > apareceu.
  >
  > Agora o override é de verdade: o operador vira contra o piloto engatado, o
  > módulo reage (PWM −128), a corrente vai a 11 A e ele desengata por
  > **sobrecorrente em menos de 300 ms**, e continua solto depois de soltar.
  >
  > **Isso não fecha o item.** A resistência da mão no modelo é chute (12% da
  > velocidade), não medida. O número muda a *rapidez* do disparo, não *se* ele
  > dispara — mas o limiar em ampères continua tendo que sair do pátio.

- **Avise o operador: apoiar a mão no volante derruba o piloto.** Medido em
  08/09 no simulado: **0,6 s** até cair, por sobrecorrente, sem o operador ter
  virado nada. Com o piloto ligado o módulo corrige de tempos em tempos, e na
  primeira correção a mão apoiada vira carga. Quem não souber vai achar que o
  sistema caiu sozinho e vai perder confiança nele. O tempo exato depende do
  chute de resistência acima; o comportamento não.
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
