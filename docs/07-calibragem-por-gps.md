# Medir o esterçamento pelo GPS, sem sensor na roda

**Data:** 2026-09-07. Feito e validado no simulador, **ainda não no trator**.

---

## O problema que isso ataca

O módulo não tem sensor de ângulo de roda (WAS). Ele deduz o ângulo contando
pulsos do encoder do motor:

```
ângulo = (contagens - centro) / CPD
```

Os três números dessa conta são chutados hoje:

| número | de onde vem hoje | o que acontece se estiver errado |
|---|---|---|
| **CPD** (contagens por grau) | digitado na tela do AgOpenGPS, no olho | o ângulo na tela sai proporcionalmente errado; o Kp que parecia bom vira outro |
| **centro** | gravado no boot, supondo rodas retas | o piloto persegue uma linha deslocada |
| **sentido** | constante fixa no firmware | motor montado ao contrário faz o trator **fugir** da linha |

Nenhum dos três dá erro na tela quando está errado. Foi assim que o teste de
campo de 30/08 se perdeu, e é o que a checagem de 05/09 quase deixou passar de
novo: o firmware lia -28,5° com a roda em +12,1° e **nada avisava**.

## A ideia

O trator já é um sensor de ângulo, só que indireto. O modelo da bicicleta — o
mesmo que o simulador usa para andar — diz:

```
curvatura do caminho = tan(ângulo das rodas) / entre-eixos
```

Invertendo, e medindo a curvatura pelo GPS:

```
ângulo real = atan( entre-eixos × curvatura )
```

Isso dá o ângulo **verdadeiro** das rodas sem depender do encoder. Comparando
com as contagens no mesmo trecho, uma reta resolve os três números de uma vez:

```
ângulo = a + b × contagens        →    CPD = 1/b     centro = -a/b
                                       sinal de b = sentido de montagem
```

Não é chute. É medida, e sai de um passeio na lavoura.

## Duas armadilhas que custaram a primeira versão

Vale registrar porque as duas parecem certas e não são.

**1. Não dá para tirar curvatura de duas posições seguidas.**
A 6 km/h o AgOpenGPS entrega uma posição a cada 16 cm. Com RTK de 2 cm, o rumo
derivado de duas delas tem cerca de **10° de ruído**, e a taxa de giro derivada
disso tem mais ruído que sinal. A primeira versão fazia exatamente isso e
devolvia CPD 0,2 onde a verdade era 19. O jeito certo é ajustar um **arco** a
uma janela de ~1 s de posições: o erro de cada ponto se cancela em vez de ser
amplificado pela derivada.

**2. O lado ruidoso tem que ficar na resposta, não no regressor.**
Ajustar "contagens em função do ângulo" parece natural, mas o ângulo é o lado
ruidoso. Ruído no regressor puxa a inclinação para zero — chama-se diluição de
regressão — e o CPD sai menor do que é. As contagens do encoder são quase
limpas, então a reta certa é "ângulo em função das contagens", e o CPD é o
**inverso** da inclinação.

## O que ele mede, medido contra verdade conhecida

`node testes/calibragem.js` monta um mundo com valores escolhidos, dirige, e
exige que o calibrador devolva os mesmos números olhando só para posição
ruidosa (RTK, 2 cm) e encoder.

| caso | verdade | medido | veredito |
|---|---|---|---|
| CPD do JD 5078 | 19 | 19,6 | ok (3%) |
| CPD errado configurado | 100 | 102,8 | ok |
| motor ao contrário | invertido | **acusou** | ok |
| centro com rodas tortas no boot | -76 contagens | -76 | ok (0,01°) |
| a 3 km/h (velocidade de plantio) | 19 | 20,9 | ok (10%), R² baixo |
| sem ruído de GPS | 19 | erro 1,7% | limite do método |
| andando reto | — | **se recusou** | ok |
| trator parado | — | **se recusou** | ok |

As duas recusas importam tanto quanto os acertos: sem curva não há curvatura
para medir, e parado a conta divide por zero. Devolver um número nesses casos
seria pior que não responder.

## Corrigir, não só medir

O botão **Aplicar no AgOpenGPS** escreve o CPD e o Ackerman medidos no PGN 252 e
ajusta o `offsetDirecao` para o zero cair onde o GPS diz que as rodas estão
retas. Ponta a ponta (`node testes/corrigir-cpd.js`), começando com 100
configurado numa máquina de 19:

```
ANTES  roda 5,1°  ·  o módulo acha 1,0°  ·  escala 0,19x
       CPD medido pelo GPS: 21,0 (configurado: 100)
       ATENÇÃO: o configurado está 0,21x fora
aplicar: CPD 100 → 21, offset 4, Ackerman 97
DEPOIS roda 5,0°  ·  o módulo acha 4,7°  ·  escala 0,94x
```

Duas decisões de projeto que valem registrar:

- **Aplicar é ação do operador, nunca automática.** Medir pode rodar sozinho o
  tempo todo; mexer no ajuste com o trator andando muda o comportamento do
  piloto, e isso ninguém faz sem mandar.
- **Ele se recusa a aplicar quando o motor está montado ao contrário.** O CPD do
  AgOpenGPS é sem sinal, então aplicar a medida esconderia o defeito físico
  atrás de um número que parece certo, e o trator continuaria fugindo da linha.

Precisão medida: cerca de **10% no CPD** com ruído de RTK e um passeio de dois
minutos (21,0 medido para 19 real). Sem ruído o método erra 1,7%, então o que
sobra é ruído, não a conta. Dez por cento tira você de 5x errado e põe no
lugar certo; o ajuste fino continua sendo no olho, na linha.

## Achado de brinde: escorregamento vira erro de CPD, não deriva de centro

Com 8% de escorregamento no orbitrol o calibrador mediu CPD **21,3** onde a
mecânica pura daria 19 — e a deriva de centro deu praticamente zero.

Faz sentido: o escorregamento proporcional faz o motor girar mais contagens
para o mesmo grau de roda, o que **é** um CPD maior. Ou seja o número que sai
daqui já é o CPD **efetivo**, escorregamento incluído, que é exatamente o que se
quer configurar. A pergunta aberta na documentação ("medir o escorregamento real
do orbitrol em campo") tem resposta parcial: se ele for proporcional, some
dentro do CPD medido e não precisa de tratamento separado. Se houver deriva de
centro além disso, o campo `derivaPorMinuto` a denuncia.

## Procedimento de campo

O passeio tem que ser em **escada**, não ziguezague:

1. Piloto desligado, trator andando reto, 5–8 km/h.
2. Vira um pouco para a direita e **segura 5 segundos**.
3. Vira mais, segura 5 segundos. Repete até uns 15°.
4. Volta ao centro e faz o mesmo para a esquerda.
5. Repete o ciclo duas vezes.

Ziguezague contínuo borra o ângulo dentro da janela de medida e estraga o ajuste
do arco. Foi o que fez a primeira versão do teste não fechar.

Abaixo de 3 km/h o R² cai bastante: precisa de passeio mais longo para o mesmo
resultado.

## Onde isso mora

No simulador, em [`server/calibrador.js`](../server/calibrador.js), alimentado
pelo laço principal a 10 Hz com posição + ruído de RTK.

**No trator, mora no mesmo lugar: no PC do AgOpenGPS, não no ESP32.** Quem tem
posição e encoder ao mesmo tempo é o PC. O módulo só recebe velocidade e ângulo
alvo pelo PGN 254 — ele não faz ideia de onde o trator está. Isso encaixa com a
ideia do Pedro de uma tela de configuração separada do AgOpenGPS, com preset por
modelo de trator: o que o calibrador mede **é** o preset.

## O que ainda não foi feito

- Rodar no trator de verdade. Tudo aqui é simulador.
- **Corrigir sozinho.** Hoje ele mede sempre e só aplica quando o operador
  manda. Aplicar automático mexe em segurança e é decisão da equipe, não minha.
- Medir o entre-eixos real do JD 5078. O valor usado (2,1 m) é estimativa, e ele
  entra direto na conta: errar 10% no entre-eixos erra 10% no CPD.
