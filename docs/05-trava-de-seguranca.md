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
