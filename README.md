# Bot de cocheras — Villa Crespo

Avisa por Telegram cuando aparece una **cochera en alquiler para auto** a **5 cuadras o menos**
de **Av. Corrientes 5753, Villa Crespo (CABA)**.

- Bot de Telegram: [`@cocheras_villacrespo_bot`](https://t.me/cocheras_villacrespo_bot) ("Cocheras Villa Crespo")
- Corre solo, gratis, cada 30 minutos. No hace falta tenerlo abierto ni revisarlo.
- Comandos (webhook en el Worker, respuesta instantánea):
  - `/cercanas` — lista de garages comerciales a ≤5 cuadras con teléfono, para preguntar por abono mensual. Datos relevados de Google Maps el 2026-09-02, hardcodeados en `worker/src/index.js` (no se scrapean, casi no cambian).
  - `/start`, `/help` — qué hace el bot.
- Destinatarios de los avisos: `TELEGRAM_CHAT_ID` + los ids en `chat_ids.json`. Con el webhook activo NO se puede usar `getUpdates`, así que para sumar a alguien hay que agregar su id a `chat_ids.json` a mano.

## Qué filtra

- **Fuente:** MercadoLibre Inmuebles (`inmuebles.mercadolibre.com.ar`), categoría cocheras/alquiler,
  barrios Villa Crespo, Almagro, Chacarita, Caballito y Palermo. Sin login ni API paga.
- **Radio:** geocodifica la dirección de cada aviso con Nominatim (OpenStreetMap, gratis) y mide
  distancia en línea recta a la casa. Se queda con lo que está a ≤ 600 m (~5 cuadras porteñas).
  Los resultados de geocoding se cachean en `geocache.json` (se commitea) para no repetir pedidos.
- **Para auto, no moto:** descarta avisos que solo mencionan "moto" y no "auto/camioneta".
- **Cochera de verdad:** descarta propiedades mal categorizadas (título sin "cochera/garage" y
  área > 40 m², o cualquier área > 60 m²).
- **Sin tope de precio** (Nicolás no fijó presupuesto). Para poner uno: `PRICE_MAX_ARS` en `scraper.js`.
- Avisos en USD se descartan (no hay cotización cargada acá).
- Direcciones sin altura exacta: solo se mandan si son en Villa Crespo, marcadas
  "⚠️ sin dirección exacta".

**Facebook Marketplace / particulares fuera de ML no están incluidos:** requieren login y tienen
anti-bot que no pasa desde GitHub Actions (misma limitación que los bots de autos y deptos).
Casi toda la oferta de cocheras está en ML.

## Cómo funciona

1. `scraper.js` corre en GitHub Actions (`.github/workflows/buscar-cocheras.yml`): busca, filtra,
   geocodifica y manda por Telegram.
2. Guarda los IDs ya avisados en `sent_ids.json` y la caché de geocoding en `geocache.json`
   (ambos se commitean solos al final de cada corrida).
3. **El cron real vive en Cloudflare.** El `schedule` de GitHub Actions no es confiable en repos
   nuevos (nunca dispara solo). El Worker `bot-cocheras-caba-cron` tiene un Cron Trigger nativo
   (`*/30 * * * *`) que dispara el workflow por la API de GitHub. El `schedule` del workflow queda
   como respaldo.

## Setup (ya hecho)

- Repo GitHub: `enginecpu1-cyber/bot-cocheras-caba` (público)
- Secrets de Actions: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- Cuenta Cloudflare: `enginecpu1@gmail.com` — Worker `bot-cocheras-caba-cron` con Cron Trigger
- Secret del Worker: `GITHUB_DISPATCH_TOKEN` (token de `gh` con scope `workflow`; a futuro
  conviene un PAT fine-grained dedicado como en los bots hermanos)

Todo el deploy está automatizado en `deploy.sh` (lee los secretos de `.env.deploy`, que no se commitea).

## Correr manualmente

GitHub → Actions → "Buscar cocheras CABA" → "Run workflow". O local:

```bash
npm install
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node scraper.js
```

Con `DRY_RUN=1` no envía ni guarda estado, solo imprime qué encontró.

## Ajustar criterios

Al principio de `scraper.js`: `HOME`, `RADIUS_M`, `PRICE_MAX_ARS`, `BARRIOS`. Los filtros de
cochera/moto son las funciones `passesBasics` / `isMotoOnly` y las regex `NON_COCHERA` / `COCHERA_POS`.
