# Começando do zero

Para quem vai mexer no simulador sem ter vindo do mundo de firmware. Não
pressupõe nada de eletrônica.

---

## O que existe no trator

Um trator tem volante, igual carro. O piloto automático coloca **um motor
elétrico grudado no volante** para girar sozinho.

Três peças conversando:

```
   notebook                 plaquinha                motor
  (AgOpenGPS)      →         (ESP32)         →      (Keya)      →  volante gira
"vira 10° à esq"         traduz o recado           obedece
```

- **AgOpenGPS** — o programa no notebook. Sabe onde o trator está (GPS) e onde
  deveria estar (a linha a seguir). Decide o ângulo.
- **ESP32** — um computador do tamanho de um chiclete, uns R$30. É a plaquinha.
  Fica no meio traduzindo. **O código dele é o que estamos testando.**
- **Motor Keya** — o motor que gira o volante.

**Por que precisa de tradutor?** O notebook e o motor falam línguas diferentes.
É como ter um front em REST e um serviço que só aceita gRPC: alguém no meio
converte. Esse alguém é a plaquinha.

## Vocabulário

| Palavra | O que é |
|---|---|
| **esterçar** | virar as rodas. "Roda esterçada em 10°" = roda virada 10 graus |
| **PGN 254** | o recado do notebook para a plaquinha: *"quero a roda em 10°"* |
| **PGN 253** | a resposta da plaquinha: *"a roda está em 8°, aplicando força 120"* |
| **PWM** | a força mandada ao motor, de 0 a 255. É o acelerador |
| **encoder** | contador de voltas dentro do motor |
| **corrente** | quanta eletricidade o motor puxa |
| **COM3** | o endereço da plaquinha na USB, como `localhost:3000` é o do servidor |
| **bandeira** | os quadradinhos de status na tela (piloto, trava, motor, ré) |
| **orbitrol** | a válvula hidráulica da direção, entre o volante e as rodas |
| **WAS** | sensor de ângulo instalado na roda (o que o projeto ainda não tem) |

### Duas dessas merecem mais

**Encoder.** O sistema não tem sensor na roda. Então conta as voltas do motor
para **adivinhar** onde a roda está. Se o motor deu 5 voltas e cada volta vira
a roda 2°, a plaquinha conclui "roda em 10°". A pergunta do projeto é
exatamente se essa conta se sustenta ou se falta um sensor de verdade (o WAS).

**Corrente.** Segurar o volante faz o motor forçar, e forçar puxa mais
eletricidade. É assim que o sistema percebe a mão do operador e se desliga —
sem sensor nenhum, só olhando o consumo. Por isso a corrente aparece na tela.

## Os dois modos do simulador

| | **Simulado** | **Placa** |
|---|---|---|
| O código da plaquinha | compilado, rodando no PC | gravado no ESP32 de verdade |
| Motor | de mentira, mas existe | **não existe** |
| O piloto guia sozinho? | **sim** | **não** |
| Serve para | a lógica, a guiagem, os casos-limite | provar que a plaquinha conversa mesmo |

### Por que o piloto não funciona no modo placa

O motor ficou com o Pedro. E o motor conversa com a plaquinha por um **cabo
separado** (o barramento CAN), que não passa pelo USB — o PC não tem como
fingir que é o motor.

Sem motor:

- a plaquinha não tem o que girar
- ela não sabe onde a roda está, então reporta **0°** sempre
- o campo *firmware acha* fica em zero enquanto *roda de verdade* mostra onde
  ela está

**Isso não é defeito, é peça faltando.** Para testar o piloto guiando na linha,
usar o **simulado**.

## O que fazer, na prática

**Quero ver o piloto seguindo a linha** → modo simulado. Andar um pouco, marcar
A, andar mais, marcar B, apertar Enter.

**Quero saber se a plaquinha está viva e qual firmware tem nela** → modo placa.
O banner aparece na tela com a data de compilação.

**Quero saber se o encoder dá conta sem o WAS** → modo simulado, subir o
*escorregamento do orbitrol* e ver se a diferença entre os dois ângulos cresce.

## Documentos seguintes

- [01-como-funciona.md](01-como-funciona.md) — como o simulador é feito por dentro
- [02-usar-a-placa.md](02-usar-a-placa.md) — driver, gravar firmware, conectar
