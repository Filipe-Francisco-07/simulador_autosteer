# A trava de segurança fica presa — confirmado na placa

**Data:** 2026-09-05. Placa do Pedro, firmware de bancada, malha fechada.

Responde à pergunta deixada em aberto na
[análise do teste de bancada de 01/09](../../AgroPreciso/AgroPreciso/docs/referencia/teste-campo-analise-2026-09-01.md),
que dizia: *"não há como confirmar sem a placa — o firmware, em modo serial, não
imprime nada além do banner"*.

---

## A hipótese

O Pedro leu no código:

```cpp
inline bool engateDecidir(bool pedido, bool& trava) {
    if (!pedido) trava = false;   // só cai na BORDA DE DESCIDA
    return pedido && !trava;
}
```

E deduziu: se `travaSeguranca` estiver `true` e o AOG mandar `engatar:true`
**direto**, sem nunca ter mandado `false` naquele boot, não existe borda de
descida — o piloto fica preso desligado até o ESP32 reiniciar. Era a explicação
mais provável para o AogFake reportar PWM 100 (o valor de repouso) nos itens de
engate.

## O que foi medido

Com o modo bancada a malha fecha, então dá para armar a trava de propósito e
ver o que acontece depois:

| # | O que foi feito | Resultado |
|---|---|---|
| 1 | engate normal | **aciona** |
| 2 | mão no volante (override) | **larga** — trava armada |
| 3 | mão sai, o AOG **continua** pedindo engate | **continua solto** |
| 4 | operador desliga e liga o piloto na tela | **volta a acionar** |

**A hipótese se sustenta.** O passo 3 é o ponto: tirar a mão não basta. Enquanto
o AOG não parar de pedir, a trava não solta.

## O que isso significa

### Não é defeito — é a proteção funcionando

A trava existe por um motivo documentado: até 29/08 o desengate por override
durava **um ciclo só** e o motor voltava a forçar contra a mão do operador
(commit `7340706`). A trava foi a correção. Ela segurar até o operador
reconhecer é o comportamento desejado.

### Mas cria dois problemas práticos

**1. Ferramentas de teste que engatam direto parecem encontrar um módulo morto.**
É o caso do AogFake: os itens 1 a 3 não tocam no PGN 254, e o item 4 manda
`engatar:true` de uma vez. Com a trava herdada de uma sessão anterior
(um Ctrl+C com o piloto ligado basta), ele nunca destrava e todo o resto do
teste falha — sem nenhuma pista do motivo.

> Foi o que aconteceu em 01/09. E é por isso que o mesmo AogFake passou 10/10
> aqui em 01/09 à noite: a placa tinha acabado de ser regravada, então a trava
> estava limpa.

**2. No trator, o operador precisa saber.** Se a trava armar — por override
legítimo ou por um pico de corrente — o piloto simplesmente **para de responder
ao botão**. Quem não souber vai achar que o sistema quebrou. A recuperação é
simples e não é óbvia: **desligar o piloto na tela e ligar de novo**.

## Recomendações

| Para | O quê |
|---|---|
| **teste de campo** | incluir na rotina: se o piloto não engatar, desligar e ligar na tela antes de qualquer outro diagnóstico |
| **AogFake** | mandar um `engatar:false` antes do item 4, para garantir a borda de descida e não testar em cima de estado herdado |
| **firmware** (a avaliar) | soltar a trava também quando o motor volta ao normal por um tempo, ou reportar o estado dela num campo de diagnóstico — hoje ela é invisível de fora |

O terceiro item é decisão do Pedro: soltar sozinho enfraquece a proteção que ele
criou de propósito. **Reportar** o estado, no entanto, resolveria a parte de não
saber o que está acontecendo, sem mexer no comportamento.

## Como repetir

```bash
node testes/trava-presa.js bancada     # com o ESP32
node testes/trava-presa.js simulado    # sem a placa
```

---

# Atualização 2026-09-07 — o Pedro mexeu nisso

O commit `fc50b61 fix(firmware): tira as travas que exigiam terminal no meio da
lavoura` reescreveu a lógica. **Tudo acima continua valendo como registro do que
foi medido em 05/09, mas não descreve mais o firmware de hoje.**

## O que mudou

A `engateDecidir` de borda de descida saiu. Agora a trava mora em
`ControleDirecao::receber`, e o que solta ela é um **nível**, não uma borda:

```cpp
if (!pedido) {
    ligado = false; pwm = 0;
    if (!viuDesligado) { viuDesligado = true; inicioDesligado = agora; }
    reconhecido = (agora - inicioDesligado) >= 250
        && hbFresco(agora) && referencia && limitesValidos()
        && !(erroMotor & 0xFFFE) && corrente < limiar;
    if (reconhecido) { trava = false; falha = Nenhuma; }
}
```

> ### Correção de 09/09 — eu errei a leitura disto em 07/09
>
> Escrevi aqui que "a trava cai sozinha" e que o ciclo desliga/liga na tela não
> era mais necessário. **Está errado, e a medição mostra o contrário**
> (`node testes/trava-presa.js simulado`, 09/09):
>
> ```
> 1. engate normal ................. aciona
> 2. mao no volante ................ largou (trava armada)
> 3. mao saiu, AOG segue pedindo ... continua solto (trava presa)
> 4. desliga e liga na tela ........ VOLTOU a acionar
> ```
>
> Comparando os dois firmwares:
>
> | | até 06/09 (`engateDecidir`) | desde 07/09 (`receber`) |
> |---|---|---|
> | o que solta a trava | qualquer `!pedido`, **na hora** | `!pedido` por **250 ms** |
> | condições extras | nenhuma | heartbeat fresco, referência, limites válidos, motor sem erro, corrente baixa |
>
> Ou seja o firmware novo é **mais exigente**, não menos. O ciclo desliga/liga
> continua obrigatório, e agora demora um pouco mais.
>
> **O que confundi:** o commit `fc50b61` chama-se *"tira as travas que exigiam
> terminal no meio da lavoura"* e ele faz isso — mas as travas que exigiam
> **terminal** (a ferramenta de serviço, op1/op2) eram outras: limites zerando,
> configuração recusada ficando presa, piscada de CAN derrubando a referência.
> Essa trava de segurança nunca exigiu terminal; ela exige a **tela**. Li o
> título do commit e estendi para o que ele não dizia.

Ou seja: **250 ms com o piloto desligado e o módulo saudável** e a trava cai.
O que mudou não foi a necessidade do ciclo, foi o que ele exige junto.

O que isso resolve das duas dores anotadas acima:

| dor de 05/09 | hoje |
|---|---|
| ferramenta que engata direto encontra módulo morto | **continua**: ela precisa mandar `engatar:false` por 250 ms antes |
| operador não sabe por que parou | resolvido: existe **código de falha** |

## A terceira recomendação virou código

A recomendação que ficou como "decisão do Pedro" — *reportar o estado num campo
de diagnóstico* — foi implementada. O byte 12 do PGN 253, que aparece no campo
**PWM** da tela Steer Settings do AgOpenGPS, agora tem dois usos:

- **acionando** → o PWM de verdade;
- **parado** → o **código do motivo**.

| código | significa |
|---|---|
| 0 | nenhuma |
| 1 | sem zero de partida |
| 2 | salto de encoder |
| 3 | sem heartbeat do motor |
| 4 | sem PGN do AOG |
| 5 | sobrecorrente |
| 6 | motor em erro |
| 7 | transporte CAN |
| 8 | ajuste trocado ou recusado |
| 9 | fora do curso |
| 10 | abaixo da velocidade mínima |

> **Cuidado com o código 8.** Ele não quer dizer só "recusei o ajuste": o mesmo
> código marca o caminho normal de *"o ajuste mudou, então desengatei por
> segurança"*. Aqui em 07/09 ele apareceu logo depois de zerar as rodas e mandou
> caçar um defeito que não existia. No simulador o rótulo é
> **"ajuste trocado ou recusado"** por causa disso.

Até 06/09 esse mesmo byte, com o motor parado, devolvia o **CPD em uso**. Quem
tiver anotação antiga de teste com esse campo precisa saber qual firmware estava
gravado para interpretar o número.

## O que passou a ser exigido no arranque

Novidade do commit `4b0868c feat(firmware): zero de partida ao energizar`: o
módulo **nasce sem referência** (`falha = 1`, sem zero de partida) e centra
sozinho no primeiro instante em que encontrar, ao mesmo tempo:

- piloto desligado,
- velocidade **zero**,
- heartbeat do Keya fresco,
- PGN do AOG recente,
- motor sem erro.

Consequência prática que vale anotar para o campo: **se a placa reiniciar com o
trator andando, ela não recentra até o trator parar.** O código na tela vai ser
1. Parar e esperar resolve; não precisa de terminal.

## O que isso quebrou no simulador (e foi consertado)

O simulador só mandava o PGN 252 quando alguém mexia num controle da tela.
Com o firmware novo isso ficou visível: o módulo rodava com os padrões **dele**
(CPD 100, Kp 40, PWM alto 162) enquanto o painel exibia os valores do servidor,
e ninguém via a diferença — toda medida de sintonia feita assim media um ganho
diferente do mostrado. Agora o servidor manda os ajustes no arranque e depois de
cada reinício, como o AgIO faz.

## Como repetir

```bash
node testes/trava-presa.js simulado    # sem a placa
node testes/trava-presa.js bancada     # com o ESP32 e o firmware de bancada
```
