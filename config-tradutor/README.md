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

## Uma armadilha que vale saber

O firmware **junta** as mudanças antes de escrever na NVS. Logo depois de
gravar, `flashPendente` ainda é `true`, e isso **não** quer dizer que persistiu.
A ferramenta espera esse sinal cair antes de dizer "gravado na flash". Sem isso
ela mentiria num caso que só apareceria quando o operador desligasse a chave.
