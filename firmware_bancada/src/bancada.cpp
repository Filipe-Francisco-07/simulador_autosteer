// FIRMWARE DE BANCADA — o tradutor de verdade, com o motor vindo pela USB.
//
// O problema: o modulo fala com o motor Keya por CAN, um barramento fisico que
// o PC nao alcanca. Sem o motor na mao, a placa nunca recebe heartbeat, o
// angulo fica em zero e a malha nao fecha. Sobrava testar so a conversa com o
// AgOpenGPS.
//
// A saida: o ESP32 consegue receber os proprios quadros CAN (modo NO_ACK com
// self reception — a mesma tecnica do can_selftest.cpp, ja validada 16/16
// nesta placa). Entao o PC manda o heartbeat do Keya pela USB, este firmware
// injeta o quadro no barramento interno, e a logica de traducao o recebe
// exatamente como se viesse do motor.
//
// Resultado: a malha fecha com o firmware RODANDO NO ESP32 — tipos de inteiro
// reais, millis() real, buffer serial real. So o motor e de mentira.
//
// O QUE MUDA em relacao ao firmware de producao:
//   1. o TWAI sobe em NO_ACK (para funcionar sem ninguem no barramento)
//   2. a serial passa por um filtro que separa o PGN 240 (injecao de CAN)
// A logica de traducao — angulo, PID, override, trava — e a MESMA, incluida
// do main.cpp de producao sem uma linha alterada.
//
// Gravar:  pio run -e bancada -t upload
// Voltar ao firmware de producao depois:
//          pio run -e esp32doit-devkit-v1 -t upload   (no repo AgroPreciso)

#include <Arduino.h>
#include "driver/twai.h"

// ---------------------------------------------------------------- injecao
// Quadro que o PC manda para se passar pelo motor:
//   80 81 7F F0 08 <8 bytes do heartbeat> <crc>
static const uint8_t PGN_INJETAR_CAN = 0xF0;
static const uint32_t ID_HEARTBEAT_KEYA = 0x07000000u | 1;

static uint32_t injetados = 0;

// Eco do que o modulo manda ao motor.
//
// O PGN 253 so reporta o MODULO do PWM (labs), sem sinal — quem so olha ele
// tem de adivinhar para que lado o motor vai. Com o eco, o PC sabe o comando
// exato que o motor receberia, e o motor simulado fica fiel em vez de
// deduzido. Ecoamos num PGN proprio (241) para nao mexer no protocolo.
static const uint8_t PGN_ECO_CAN = 0xF1;

static void injetarNoBarramento(const uint8_t dados[8]) {
    twai_message_t m = {};
    m.identifier = ID_HEARTBEAT_KEYA;
    m.extd = 1;
    m.self = 1;                 // volta para nos: e isso que faz a logica ve-lo
    m.data_length_code = 8;
    memcpy(m.data, dados, 8);
    if (twai_transmit(&m, pdMS_TO_TICKS(10)) == ESP_OK) injetados++;
}

// Espiao do barramento: repassa a transmissao para o driver de verdade e
// manda uma copia ao PC. Trocamos o nome de `twai_transmit` antes de incluir o
// firmware, entao a logica de producao continua chamando o que sempre chamou.
static void ecoarComandoCan(const twai_message_t* m);

static inline esp_err_t twai_transmit_espionado(const twai_message_t* m, TickType_t espera) {
    const esp_err_t r = twai_transmit(m, espera);
    if (!m->self) ecoarComandoCan(m);      // injecao nossa nao vira eco
    return r;
}

// ---------------------------------------------------------------- serial filtrada
// O firmware de producao le a serial sozinho. Para interceptar o PGN de
// injecao sem tocar nele, trocamos o objeto `Serial` que ele enxerga: este
// aqui consome os quadros de injecao e entrega o resto igualzinho.
class SerialFiltrada {
public:
    void begin(uint32_t baud) { Serial.begin(baud); }
    void flush() { Serial.flush(); }
    void write(const uint8_t* d, size_t n) { Serial.write(d, n); }
    void print(const char* s) { Serial.print(s); }
    void println(const char* s) { Serial.println(s); }
    void println() { Serial.println(); }
    template <typename... A> void printf(const char* f, A... a) { Serial.printf(f, a...); }
    operator bool() const { return true; }

    int available() { encher(); return (int)(fim - ini); }

    int read() {
        encher();
        if (ini >= fim) return -1;
        return fila[ini++];
    }

private:
    // O filtro monta os quadros do mesmo jeito que o firmware: procura 8081,
    // le o tamanho, junta o resto. So que ele decide o que fazer com o quadro
    // pronto — injetar, ou passar adiante.
    void encher() {
        while (Serial.available() && fim < sizeof fila) {
            const uint8_t b = (uint8_t)Serial.read();

            if (pos == 0) { if (b == 0x80) buf[pos++] = b; else passar(&b, 1); continue; }
            if (pos == 1) {
                buf[pos++] = b;
                if (b != 0x81) { passar(buf, 2); pos = 0; }
                continue;
            }
            buf[pos++] = b;

            if (pos == 5) {
                faltam = buf[4] + 1;
                if (faltam > (uint8_t)(sizeof buf - 5)) { passar(buf, pos); pos = 0; }
                continue;
            }
            if (pos > 5 && pos == 5 + faltam) {
                if (buf[3] == PGN_INJETAR_CAN && buf[4] == 8) injetarNoBarramento(&buf[5]);
                else passar(buf, pos);          // nao e injecao: e do firmware
                pos = 0;
            }
            if (pos >= sizeof buf) pos = 0;
        }
    }

    void passar(const uint8_t* d, uint8_t n) {
        for (uint8_t i = 0; i < n && fim < sizeof fila; i++) fila[fim++] = d[i];
    }

    uint8_t buf[40] = {0};
    uint8_t pos = 0, faltam = 0;
    uint8_t fila[192] = {0};
    uint16_t ini = 0, fim = 0;

public:
    // chamado uma vez por volta do laco: recicla a fila quando ela esvazia
    void compactar() { if (ini >= fim) { ini = 0; fim = 0; } }
};

static SerialFiltrada serialFiltrada;

// ---------------------------------------------------------------- o firmware real
// A partir daqui, tudo que o main.cpp chamar de `Serial` e o filtro acima, e o
// TWAI sobe em NO_ACK. Nada mais muda: o angulo, o PID, o override e a trava
// vem do arquivo de producao, sem copia.
#define Serial serialFiltrada
#define twai_transmit twai_transmit_espionado
#define TWAI_MODE_NORMAL TWAI_MODE_NO_ACK
#define setup setup_do_firmware
#define loop  loop_do_firmware
#include "main.cpp"
#undef loop
#undef setup
#undef TWAI_MODE_NORMAL
#undef twai_transmit
#undef Serial

// Precisa vir depois do include: usa o CRC do proprio protocolo do AOG.
static void ecoarComandoCan(const twai_message_t* m) {
    uint8_t q[14];
    q[0] = 0x80; q[1] = 0x81; q[2] = AOG_SRC_MODULO; q[3] = PGN_ECO_CAN; q[4] = 8;
    memcpy(&q[5], m->data, 8);
    q[13] = aogCrc(q, 14);
    ::Serial.write(q, sizeof q);
}

// ---------------------------------------------------------------- bancada
void setup() {
    setup_do_firmware();
    ::Serial.println("# MODO BANCADA: heartbeat do Keya entra pela USB (PGN 240)");
    ::Serial.println("# a logica de traducao e a de producao, sem alteracao");
}

void loop() {
    loop_do_firmware();
    serialFiltrada.compactar();
}
