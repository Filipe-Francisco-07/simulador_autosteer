// Harness: roda o firmware REAL do modulo de autosteer dentro de um processo
// no PC e expoe os dois lados da ponte para o simulador.
//
// O firmware nao e reescrito nem adaptado: incluimos o main.cpp de verdade
// (do repo AgroPreciso) e trocamos so o que e hardware — Serial, CAN e o
// relogio. Se o simulador achar um bug aqui, o bug esta no firmware que vai
// gravado no ESP32.
//
// Incluir o .cpp (em vez de linkar) e proposital: as variaveis de estado do
// firmware sao `static`, entao so ficam visiveis dentro da mesma unidade de
// compilacao. E assim que o simulador consegue mostrar o angulo estimado, a
// trava de seguranca e a corrente media por dentro.
//
// PROTOCOLO (uma linha por mensagem)
//   entrada:  S <hex>              bytes da serial   (AOG    -> firmware)
//             C <id> <hex>         quadro CAN        (motor  -> firmware)
//             T <ms>               avanca o relogio e roda o loop
//             Q                    devolve o estado interno
//             R                    reinicia o firmware
//   saida:    {"t":"serial_tx",...} {"t":"can_tx",...} {"t":"state",...}

#include <cstdio>
#include <cstring>
#include <string>
#include <iostream>
#include <deque>
#include <map>
#include <string>
#include <vector>

// ---- as globais que os stubs declararam como extern ----
uint32_t g_millis = 0;
std::deque<uint8_t>  g_serialRx;
std::vector<uint8_t> g_serialTx;
std::string          g_serialLog;

#include "stubs/Arduino.h"
#include "stubs/driver/twai.h"

std::vector<twai_message_t> g_canTx;
std::deque<twai_message_t>  g_canRx;
SerialStub Serial;

// flash falsa (NVS) e motivo do boot — o firmware passou a ler os dois em 07/09
std::map<std::string, std::vector<uint8_t>> g_flash;
std::map<std::string, float> g_flashFloat;
bool g_flashFalha = false;
unsigned g_flashGravacoes = 0;
esp_reset_reason_t g_motivoBoot = ESP_RST_POWERON;

// falhas de barramento que o harness liga sob demanda
bool     g_canFalhaInstalar = false;
bool     g_canFalhaTx = false;
uint32_t g_canAlertas = 0;

// ---- o firmware de verdade ----
#include FIRMWARE_MAIN

// ---------------------------------------------------------------- utilidades
static std::string paraHex(const uint8_t* d, size_t n) {
    static const char* H = "0123456789ABCDEF";
    std::string s;
    for (size_t i = 0; i < n; i++) { s += H[d[i] >> 4]; s += H[d[i] & 0xF]; }
    return s;
}

static std::vector<uint8_t> deHex(const std::string& s) {
    std::vector<uint8_t> v;
    for (size_t i = 0; i + 1 < s.size(); i += 2)
        v.push_back((uint8_t)strtol(s.substr(i, 2).c_str(), nullptr, 16));
    return v;
}

// Drena o que o firmware produziu desde a ultima vez.
static void drenarSaidas() {
    if (!g_serialTx.empty()) {
        printf("{\"t\":\"serial_tx\",\"hex\":\"%s\"}\n",
               paraHex(g_serialTx.data(), g_serialTx.size()).c_str());
        g_serialTx.clear();
    }
    for (const auto& m : g_canTx) {
        printf("{\"t\":\"can_tx\",\"id\":%u,\"hex\":\"%s\"}\n",
               (unsigned)m.identifier, paraHex(m.data, m.data_length_code).c_str());
    }
    g_canTx.clear();
}

// Espelha o estado interno do firmware. Sao as variaveis static do main.cpp —
// visiveis porque incluimos o .cpp.
// O codigo 8 do firmware nao quer dizer so "recusei": ele tambem marca o
// caminho normal de "o ajuste mudou, entao desengatei por seguranca". Chamar
// isso de "recusada" mandava caçar um defeito que nao existe — foi o que
// aconteceu aqui em 07/09 ao ver o codigo aparecer depois de zerar as rodas.
static const char* nomeDaFalha(FalhaDirecao f) {
    switch (f) {
        case FalhaDirecao::Nenhuma:       return "nenhuma";
        case FalhaDirecao::Referencia:    return "sem zero de partida";
        case FalhaDirecao::Encoder:       return "salto de encoder";
        case FalhaDirecao::CanAusente:    return "sem heartbeat do motor";
        case FalhaDirecao::AogAusente:    return "sem PGN do AOG";
        case FalhaDirecao::Sobrecarga:    return "sobrecorrente";
        case FalhaDirecao::Motor:         return "motor em erro";
        case FalhaDirecao::TransporteCan: return "transporte CAN";
        case FalhaDirecao::Configuracao:  return "ajuste trocado ou recusado";
        case FalhaDirecao::ForaDoCurso:   return "fora do curso";
        case FalhaDirecao::Velocidade:    return "abaixo da velocidade minima";
    }
    return "?";
}

// Espelha o estado interno do firmware. Desde 07/09 quase tudo vive dentro do
// objeto `controle`; os nomes de campo antigos foram mantidos aqui de proposito
// para nao quebrar o servidor e os testes que ja liam este JSON.
static void publicarEstado() {
    printf("{\"t\":\"state\""
           ",\"ms\":%u"
           ",\"anguloAtualX100\":%d"
           ",\"anguloAlvoX100\":%d"
           ",\"pwmSaida\":%d"
           ",\"autosteerLigado\":%s"
           ",\"travaSeguranca\":%s"
           ",\"keyaVisto\":%s"
           ",\"motorDesabilitou\":%s"
           ",\"encoderAcumulado\":%d"
           ",\"encoderIniciado\":%s"
           ",\"correnteMedia\":%.3f"
           ",\"ciclosSobrecarga\":%u"
           ",\"statusPedido\":%u"
           ",\"velocidadeKmhX10\":%u"
           ",\"ganhoP\":%u,\"pwmAlto\":%u,\"pwmMinimo\":%u"
           ",\"contagensPorGrau\":%u,\"offsetDirecao\":%d"
           ",\"tUltimoPgn\":%u,\"tUltimoHb\":%u"
           ",\"referencia\":%s"
           ",\"reconhecido\":%s"
           ",\"centro\":%d"
           ",\"falha\":%u"
           ",\"falhaNome\":\"%s\""
           ",\"limiteEsquerdo\":%u,\"limiteDireito\":%u"
           ",\"limitesValidos\":%s"
           ",\"saltos\":%u"
           ",\"erroMotor\":%u"
           ",\"velocidadeMinima\":%u"
           ",\"limiar\":%u"
           ",\"canPronto\":%s"
           ",\"flashErro\":%s"
           ",\"referenciaPendente\":%s"
           "}\n",
           (unsigned)g_millis,
           (int)controle.angulo,
           (int)controle.alvo,
           (int)controle.pwm,
           controle.ligado ? "true" : "false",
           controle.trava ? "true" : "false",
           controle.viuHb ? "true" : "false",
           (controle.erroMotor & 1) ? "true" : "false",
           (int)controle.encoder.acumulado,
           controle.encoder.iniciado ? "true" : "false",
           (double)controle.corrente,
           (unsigned)controle.ciclosMotor,
           (unsigned)(controle.pedido ? 1 : 0),
           (unsigned)controle.velocidade,
           (unsigned)controle.ajustes.ganhoP,
           (unsigned)controle.ajustes.pwmAlto,
           (unsigned)controle.ajustes.pwmMinimo,
           (unsigned)controle.ajustes.contagensPorGrau,
           (int)controle.ajustes.offsetDirecao,
           (unsigned)controle.ultimoPgn, (unsigned)controle.ultimoHb,
           controle.referencia ? "true" : "false",
           controle.reconhecido ? "true" : "false",
           (int)controle.centro,
           (unsigned)controle.falha,
           nomeDaFalha(controle.falha),
           (unsigned)controle.limiteEsquerdo, (unsigned)controle.limiteDireito,
           controle.limitesValidos() ? "true" : "false",
           (unsigned)controle.saltos,
           (unsigned)controle.erroMotor,
           (unsigned)controle.velocidadeMinima,
           (unsigned)controle.limiar,
           canPronto ? "true" : "false",
           flashErro ? "true" : "false",
           referenciaPendente ? "true" : "false");
}

// Reinicia tudo ao estado de boot — inclusive o que o firmware guarda entre
// ciclos. Serve para repetir um teste do zero sem fechar o simulador.
static void reiniciar() {
    g_millis = 0;
    g_serialRx.clear(); g_serialTx.clear();
    g_canTx.clear(); g_canRx.clear();

    // Estado do firmware volta ao que seria logo apos energizar a placa.
    controle = ControleDirecao{};
    referenciaPendente = true;
    canPronto = false; flashPendente = false; flashErro = false;
    ultimaGravacao = ultimoComando = ultimoStatus = 0;
    ultimoPwm = 0;
    memset(registroSalvo, 0, sizeof registroSalvo);
    serPos = 0; ultimoByte = 0;
    alertasCanAcumulados = 0;
    settingsRejeitados = false; configRejeitada = false;

    // Flash falsa: por padrao uma placa nova, sem nada gravado. Quem quiser
    // simular placa que ja rodou no campo carrega g_flash antes de chamar "R".
    g_flashFalha = false;
    g_flashGravacoes = 0;
    g_canFalhaInstalar = false; g_canFalhaTx = false; g_canAlertas = 0;

    setup();
    drenarSaidas();
}

int main() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    reiniciar();
    printf("{\"t\":\"ready\",\"firmware\":\"%s\"}\n", FIRMWARE_NOME);

    std::string linha;
    while (std::getline(std::cin, linha)) {
        if (linha.empty()) continue;
        const char cmd = linha[0];
        const std::string arg = linha.size() > 2 ? linha.substr(2) : "";

        if (cmd == 'S') {                      // AOG -> firmware
            for (uint8_t b : deHex(arg)) g_serialRx.push_back(b);
        } else if (cmd == 'C') {               // motor -> firmware
            size_t esp = arg.find(' ');
            twai_message_t m = {};
            m.identifier = (uint32_t)strtoul(arg.substr(0, esp).c_str(), nullptr, 10);
            m.extd = 1;
            auto d = deHex(esp == std::string::npos ? "" : arg.substr(esp + 1));
            m.data_length_code = (uint8_t)(d.size() > 8 ? 8 : d.size());
            memcpy(m.data, d.data(), m.data_length_code);
            g_canRx.push_back(m);
        } else if (cmd == 'T') {               // avanca o tempo
            const uint32_t ms = (uint32_t)strtoul(arg.c_str(), nullptr, 10);
            for (uint32_t i = 0; i < ms; i++) { g_millis++; loop(); }
            if (ms == 0) loop();               // T 0 = so roda um ciclo
        } else if (cmd == 'Q') {
            publicarEstado();
            continue;
        } else if (cmd == 'R') {
            reiniciar();
            continue;
        }
        drenarSaidas();
    }
    return 0;
}
