# Configuração do tradutor, fora do AgOpenGPS

Protótipo que deu origem à aba dentro do AgOpenGPS. Continua útil para duas
coisas: mexer no módulo sem abrir o AgOpenGPS, e desenvolver sem placa nenhuma.

A versão de produto é a janela em C#, dentro do AgOpenGPS. Ver
[o guia no AgroPreciso](../../AgroPreciso/AgroPreciso/docs/guias/tradutor-aba-de-configuracao.md).

## Para que serve

Lê a configuração que está gravada no ESP32, compara com o perfil do trator
escolhido, grava o que diverge e confere lendo de volta.

Fala com duas pontas, com a mesma interface:

- a porta serial de verdade, com o **AgIO fechado** (ele segura a porta);
- o firmware real compilado para PC (`sim/firmware_sim.exe`), sem placa.

## Rodar

```bash
node config-tradutor/conferir.js          # prova o ciclo no firmware do PC
node config-tradutor/conferir.js COM6     # o mesmo, na placa
node config-tradutor/servidor.js          # tela em http://localhost:3100
```

O simulador em `http://localhost:3000` tem um botão "Config. do tradutor" que
abre a porta 3100, só por conveniência de quem está testando.

## O que a tela faz

- **perfil por trator**, gravado em `perfis.json`
- **portão**: enquanto o módulo não estiver como o perfil manda, ela cobre a
  tela e lista o que está fora
- **criar do módulo**: lê o que está lá e vira perfil, para adotar um trator já
  configurado sem redigitar

## Como a gravação funciona

Três caminhos, porque é assim que o firmware ouve:

| Quadro | O que leva |
|---|---|
| PGN 252 | CPD, Ackerman, ganho, PWM, offset |
| PGN 251 | corrente de desligamento, velocidade mínima, bits de config |
| PGN 240 op2 | envelope de esterçamento, em centésimos de grau |

A corrente de desligamento só é aceita com sensor de carga marcado (`set1` bit 1
pressão, bit 2 corrente). Sem isso o firmware lê o campo como contagem de pulso
de encoder e ignora. A ferramenta liga esse bit ao gravar.

## O modulo falso, para testar a aba do AgOpenGPS

`modulo-falso.js` faz o papel do ESP32 falando UDP, para exercitar a janela
dentro do AgOpenGPS sem placa nenhuma.

Ele existe por causa de um detalhe do AgIO: em `ReceiveFromLoopBack` a linha
`SendUDPMessage(data, epModule)` vem **antes** do switch de PGN, entao tudo que
o AgOpenGPS manda sai para a rede na porta 8888, e a resposta volta na 9999. O
programa escuta a 8888 e responde na 9999.

Imita o firmware no que a aba precisa:

- manda PGN 253 a cada 100 ms, que e o que acende o modulo no AgOpenGPS
- responde ao PGN 240 com assinatura AP01 devolvendo o PGN 239
- guarda o que chega por PGN 252, PGN 251 e servico op2
- segura `flashPendente` por 600 ms antes de assentar, igual a NVS de verdade
- aplica a mesma regra do `set1 & 0x06`: sem sensor de carga marcado, o campo
  de corrente nao vira limiar

```bash
node config-tradutor/modulo-falso.js            # responde normalmente
node config-tradutor/modulo-falso.js --mudo     # manda 253, nunca devolve 239
```

O `--mudo` serve para ver a mensagem que a aba mostra quando o modulo esta
ligado mas a pergunta nao chega nele. E diferente da de "sem modulo nenhum", e
essa diferenca e o que evita o operador ir mexer no cabo quando o problema e o
software.

Depois abra o AgIO, ligue o UDP nele (icone de rede, **UDP Off** vira **UDP Is
On**), reabra o AgIO, porque a porta 9999 so abre no arranque, e ponha a
sub-rede na do PC com **Auto Fill New Subnet** e **Set Subnet**. Ai abra o
AgOpenGPS e va em Wizards, Config. do tradutor.

O que ele **nao** cobre: o quadro sai pelo caminho de rede, que ja existia no
AgIO. O caminho serial, que e o do monitor de verdade com o tradutor no USB, so
fecha com um ESP32 numa porta COM.

## Uma armadilha que vale saber

O firmware **junta** as mudanças antes de escrever na NVS. Logo depois de
gravar, `flashPendente` ainda é `true`, e isso **não** quer dizer que persistiu.
A ferramenta espera esse sinal cair antes de dizer "gravado na flash". Sem isso
ela mentiria num caso que só apareceria quando o operador desligasse a chave.
