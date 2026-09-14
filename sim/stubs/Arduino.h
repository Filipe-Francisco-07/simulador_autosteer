// Stub do Arduino para rodar o firmware REAL no PC.
//
// Nada aqui imita hardware de verdade: a Serial vira uma fila de bytes que o
// simulador enche/esvazia, e millis() vira um relogio que o simulador controla.
// O firmware nao sabe a diferenca — e esse o ponto: testamos o codigo que vai
// gravado no ESP32, sem trocar uma linha dele.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <deque>
#include <vector>

// ---- relogio controlado pelo simulador ----
extern uint32_t g_millis;
inline uint32_t millis() { return g_millis; }
inline void delay(uint32_t ms) { g_millis += ms; }

// ---- Serial: fila de entrada (do AOG) e de saida (para o AOG) ----
extern std::deque<uint8_t> g_serialRx;   // bytes que o AOG mandou
extern std::vector<uint8_t> g_serialTx;  // bytes que o firmware respondeu

struct SerialStub {
    void begin(uint32_t) {}
    int  available() { return (int)g_serialRx.size(); }
    int  read() {
        if (g_serialRx.empty()) return -1;
        uint8_t b = g_serialRx.front();
        g_serialRx.pop_front();
        return b;
    }
    void write(const uint8_t* d, size_t n) {
        for (size_t i = 0; i < n; i++) g_serialTx.push_back(d[i]);
    }
    // O firmware imprime o banner antes de entregar a porta ao AOG.
    // Guardamos como texto para o simulador exibir, sem misturar com PGN.
    void print(const char*) {}
    void println(const char*) {}
    void println() {}
    void printf(const char*, ...) {}
    void flush() {}
    operator bool() const { return true; }
};
extern SerialStub Serial;

// ---- pinos (o modulo de direcao nao usa nenhum, mas o codigo referencia) ----
#define HIGH 1
#define LOW  0
#define OUTPUT 1
#define INPUT  0
#define INPUT_PULLUP 2
inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
inline int  digitalRead(int) { return 0; }
inline uint32_t micros() { return g_millis * 1000; }

typedef enum {
    GPIO_NUM_4 = 4, GPIO_NUM_5 = 5, GPIO_NUM_16 = 16, GPIO_NUM_17 = 17,
    GPIO_NUM_21 = 21, GPIO_NUM_22 = 22
} gpio_num_t;

#define ESP_OK 0
typedef int esp_err_t;
inline uint32_t pdMS_TO_TICKS(uint32_t ms) { return ms; }

// ---- motivo do ultimo boot ----
// O firmware imprime isto no banner desde 07/09 para separar defeito de software
// (PANIC, WDT) de problema eletrico (BROWNOUT). No PC nao ha silicio para
// consultar, entao o harness escolhe o valor; o padrao honesto e POWERON.
typedef enum {
    ESP_RST_UNKNOWN = 0, ESP_RST_POWERON, ESP_RST_EXT, ESP_RST_SW, ESP_RST_PANIC,
    ESP_RST_INT_WDT, ESP_RST_TASK_WDT, ESP_RST_WDT, ESP_RST_DEEPSLEEP,
    ESP_RST_BROWNOUT, ESP_RST_SDIO
} esp_reset_reason_t;
extern esp_reset_reason_t g_motivoBoot;
inline esp_reset_reason_t esp_reset_reason() { return g_motivoBoot; }
