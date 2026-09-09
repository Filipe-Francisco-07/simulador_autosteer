# Documentação — simulador de tradução

## Para o dia do teste

| Documento | Sobre |
|---|---|
| [06-antes-do-campo.md](06-antes-do-campo.md) | **comece por aqui na véspera**: o que rodar, que Kp usar, e o que fazer se o piloto não engatar |
| [05-trava-de-seguranca.md](05-trava-de-seguranca.md) | por que o piloto às vezes para de responder ao botão, e a **tabela dos códigos de falha** que aparecem no campo PWM |
| [07-calibragem-por-gps.md](07-calibragem-por-gps.md) | medir CPD, centro e sentido de montagem **pelo GPS**, sem sensor na roda |
| [08-limites-do-firmware.md](08-limites-do-firmware.md) | os dois tetos duros (atraso de heartbeat e velocidade do motor) e por que a sintonia de Kp ainda não fecha |

## Para entender e usar

| Documento | Sobre |
|---|---|
| [00-comecando-do-zero.md](00-comecando-do-zero.md) | se firmware e eletrônica são novidade: o que é cada peça e cada palavra |
| [01-como-funciona.md](01-como-funciona.md) | arquitetura do simulador e as decisões de projeto |
| [02-usar-a-placa.md](02-usar-a-placa.md) | driver CH340, conectar o ESP32, e o que cada firmware faz |
| [04-modo-bancada.md](04-modo-bancada.md) | o ESP32 traduzindo de verdade, sem o motor na mesa |
| [03-resultados.md](03-resultados.md) | tudo que foi medido, com número — e os defeitos encontrados |

Para usar o simulador no dia a dia, o [README](../README.md) da raiz basta.

> **Atualizado em 2026-09-07** para o firmware do fim de semana do Pedro
> (`3d87c18`..`4ed6623`): zero de partida ao energizar, códigos de falha no campo
> PWM, e a trava que não exige mais terminal. As notas anteriores viraram
> registro histórico dentro de cada documento, não foram apagadas.

> **Repositório privado.** Não espelhar no `automacao_agricola` enquanto o
> teste não fechar — combinado com o Filipe em 01/09.
