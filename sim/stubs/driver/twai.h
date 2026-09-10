// Stub do TWAI (controlador CAN do ESP32).
//
// O barramento vira duas filas: o que o firmware TRANSMITE (e o simulador
// mostra no painel do Keya) e o que o simulador INJETA como se fosse o motor
// respondendo (heartbeat).
#pragma once
#include <stdint.h>
#include <string.h>
#include <deque>
#include <vector>

typedef struct {
    union {
        uint32_t flags;
        struct {
            uint32_t extd: 1;
            uint32_t rtr: 1;
            uint32_t ss: 1;
            uint32_t self: 1;
            uint32_t dlc_non_comp: 1;
            uint32_t reserved: 27;
        };
    };
    uint32_t identifier;
    uint8_t  data_length_code;
    uint8_t  data[8];
} twai_message_t;

extern std::vector<twai_message_t> g_canTx;   // firmware -> motor
extern std::deque<twai_message_t>  g_canRx;   // motor -> firmware

#ifndef ESP_OK
#define ESP_OK 0
#endif
#define ESP_FAIL -1
#define ESP_ERR_TIMEOUT 0x107

typedef int esp_err_t;

typedef struct { int mode; int tx_io; int rx_io; int clkout_io; int bus_off_io;
                 int tx_queue_len; int rx_queue_len; int alerts_enabled;
                 int clkout_divider; int intr_flags; } twai_general_config_t;
typedef struct { int brp; int tseg_1; int tseg_2; int sjw; bool triple_sampling; } twai_timing_config_t;
typedef struct { uint32_t acceptance_code; uint32_t acceptance_mask; bool single_filter; } twai_filter_config_t;

#define TWAI_MODE_NORMAL 0
#define TWAI_MODE_NO_ACK 1
#define TWAI_MODE_LISTEN_ONLY 2

// Alertas do driver. O firmware passou a pedi-los em 07/09 para largar o
// barramento quando ele cai (bus-off) em vez de seguir mandando no vazio.
#define TWAI_ALERT_TX_FAILED     0x00000004
#define TWAI_ALERT_RX_QUEUE_FULL 0x00000008
#define TWAI_ALERT_BUS_OFF       0x00000100

#define TWAI_GENERAL_CONFIG_DEFAULT(tx, rx, mode) \
    { mode, (int)(tx), (int)(rx), -1, -1, 5, 5, 0, 0, 0 }
#define TWAI_TIMING_CONFIG_250KBITS() { 16, 11, 4, 3, false }
#define TWAI_TIMING_CONFIG_500KBITS() { 8, 15, 4, 3, false }
#define TWAI_FILTER_CONFIG_ACCEPT_ALL() { 0, 0xFFFFFFFF, true }

inline esp_err_t twai_driver_install(const twai_general_config_t*,
                                     const twai_timing_config_t*,
                                     const twai_filter_config_t*);
inline esp_err_t twai_start() { return ESP_OK; }
inline esp_err_t twai_stop()  { return ESP_OK; }
inline esp_err_t twai_driver_uninstall() { return ESP_OK; }

// Falhas que o harness pode ligar para exercitar os caminhos de erro.
extern bool     g_canFalhaInstalar;   // driver nao sobe (pino errado, driver morto)
extern bool     g_canFalhaTx;         // transmissao sempre falha
extern uint32_t g_canAlertas;         // alertas pendentes, consumidos na leitura

inline esp_err_t twai_transmit(const twai_message_t* m, uint32_t) {
    if (g_canFalhaTx) { g_canAlertas |= TWAI_ALERT_TX_FAILED; return ESP_FAIL; }
    g_canTx.push_back(*m);
    return ESP_OK;
}

inline esp_err_t twai_clear_transmit_queue() { return ESP_OK; }

inline esp_err_t twai_receive(twai_message_t* m, uint32_t) {
    if (g_canRx.empty()) return ESP_ERR_TIMEOUT;
    *m = g_canRx.front();
    g_canRx.pop_front();
    return ESP_OK;
}

typedef struct { int state; int msgs_to_tx; int msgs_to_rx; } twai_status_info_t;
inline esp_err_t twai_get_status_info(twai_status_info_t* s) {
    s->state = 1; s->msgs_to_tx = 0; s->msgs_to_rx = (int)g_canRx.size();
    return ESP_OK;
}
inline esp_err_t twai_driver_install(const twai_general_config_t*,
                                     const twai_timing_config_t*,
                                     const twai_filter_config_t*) {
    extern bool g_canFalhaInstalar;
    return g_canFalhaInstalar ? ESP_FAIL : ESP_OK;
}

// Le e limpa: o firmware trata cada alerta uma vez so, igual ao driver real.
inline esp_err_t twai_read_alerts(uint32_t* a, uint32_t) {
    *a = g_canAlertas;
    g_canAlertas = 0;
    return ESP_OK;
}
inline esp_err_t twai_reconfigure_alerts(uint32_t, uint32_t*) { return ESP_OK; }
