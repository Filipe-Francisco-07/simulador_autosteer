// Flash falsa (NVS) para rodar o firmware no PC.
//
// Guarda os mesmos blocos de bytes que o ESP32 guardaria, em memoria. O harness
// pode esvaziar (placa nova), pre-carregar (placa que ja rodou no campo) ou
// mandar falhar, que e como se testa o caminho de erro de gravacao sem
// precisar de uma flash gasta de verdade.
#pragma once
#include <stdint.h>
#include <string.h>
#include <map>
#include <string>
#include <vector>

extern std::map<std::string, std::vector<uint8_t>> g_flash;
extern std::map<std::string, float> g_flashFloat;
extern bool g_flashFalha;       // begin()/putBytes() passam a falhar
extern unsigned g_flashGravacoes;

class Preferences {
public:
    bool begin(const char*, bool = false) { return !g_flashFalha; }
    void end() {}

    size_t getBytesLength(const char* chave) {
        auto it = g_flash.find(chave);
        return it == g_flash.end() ? 0 : it->second.size();
    }
    size_t getBytes(const char* chave, void* destino, size_t n) {
        auto it = g_flash.find(chave);
        if (it == g_flash.end() || it->second.size() != n) return 0;
        memcpy(destino, it->second.data(), n);
        return n;
    }
    size_t putBytes(const char* chave, const void* origem, size_t n) {
        if (g_flashFalha) return 0;
        const uint8_t* b = (const uint8_t*)origem;
        g_flash[chave] = std::vector<uint8_t>(b, b + n);
        g_flashGravacoes++;
        return n;
    }
    float getFloat(const char* chave, float padrao) {
        auto it = g_flashFloat.find(chave);
        return it == g_flashFloat.end() ? padrao : it->second;
    }
    size_t putFloat(const char* chave, float v) {
        if (g_flashFalha) return 0;
        g_flashFloat[chave] = v;
        g_flashGravacoes++;
        return sizeof(float);
    }
};
