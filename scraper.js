// Bot de MercadoLibre -> avisa por Telegram con foto. Dos busquedas:
//   1. Cocheras en alquiler para AUTO a <= 5 cuadras de Av. Corrientes 5753 (Villa Crespo).
//   2. Departamentos en alquiler CON cochera, <= $750.000 total, en Villa Crespo / Almagro / Palermo.
// Corre via GitHub Actions (ver .github/workflows/buscar-cocheras.yml).
//
// Fuente: MercadoLibre Inmuebles (inmuebles.mercadolibre.com.ar), sin login ni API paga.
// El radio se resuelve geocodificando la direccion de cada aviso con Nominatim (OSM,
// gratis) y midiendo distancia en linea recta a la casa. Los resultados de geocoding
// se cachean en geocache.json (se commitea) para no volver a pedirlos.
//
// Facebook Marketplace / particulares fuera de ML: no se incluyen en esta version
// (requieren login y tienen anti-bot que no pasa desde GitHub Actions, igual que en
// los bots hermanos de autos/deptos). Casi toda la oferta de cocheras esta en ML.

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// --- Config ---

// Av. Corrientes 5753, Villa Crespo (geocodificado con Nominatim, verificado).
const HOME = { lat: -34.5950514, lon: -58.4437928 };

// "5 cuadras" en linea recta. Una cuadra portena ~110 m; 5 en diagonal da ~600 m.
const RADIUS_M = 600;
const METERS_PER_BLOCK = 110;

// Sin tope de precio: Nicolas no fijo presupuesto, el objetivo es ver que hay cerca.
// Si mas adelante quiere filtrar, se pone un numero aca (en ARS).
const PRICE_MAX_ARS = null;

// Barrios que pueden tener avisos dentro del radio. Se sobre-consulta a proposito:
// el filtro real es la distancia, no el barrio.
const BARRIOS = ["villa-crespo", "almagro", "chacarita", "caballito", "palermo"];

const STATE_FILE = path.join(__dirname, "sent_ids.json");
const CHATS_FILE = path.join(__dirname, "chat_ids.json");
const GEOCACHE_FILE = path.join(__dirname, "geocache.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
// Nominatim pide un User-Agent identificable con forma de contacto.
const NOMINATIM_UA = "bot-cocheras-caba/1.0 (github.com/enginecpu1-cyber/bot-cocheras-caba)";

// --- Estado en disco ---

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- Destinatarios de los avisos ---
// El bot tiene un webhook en el Worker de Cloudflare (para /cercanas, /start), asi
// que aca NO se puede usar getUpdates (Telegram no permite webhook + polling a la
// vez). Los destinatarios salen de TELEGRAM_CHAT_ID + los ids ya guardados en
// chat_ids.json. Para sumar a alguien nuevo, agregar su id a ese archivo a mano.

function loadRecipients() {
  const state = loadJson(CHATS_FILE, { chatIds: [] });
  return Array.isArray(state.chatIds) ? state.chatIds : [];
}

// --- Geo ---

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// "Olaya Al 1100" -> "Olaya 1100"; "Av. Corrientes 3600 - 3900" -> "Av. Corrientes 3600";
// "Mario Bravo 800, Buenos Aires, Argentina" -> "Mario Bravo 800". Devuelve null si no
// hay numero de altura (no se puede ubicar con precision).
function parseStreet(locationRaw) {
  if (!locationRaw) return null;
  let street = locationRaw.split(",")[0].trim();
  street = street.replace(/\bal\.?\s+(\d)/i, "$1"); // "Al 1100" / "al. 1100" -> "1100"
  street = street.replace(/\s*-\s*\d+\s*$/, ""); // rango "3600 - 3900" -> "3600"
  const m = street.match(/^(.+?)\s+(\d{1,5})\b/);
  if (!m) return null;
  return `${m[1].trim()} ${m[2]}`;
}

let geocacheDirty = false;
async function geocode(street, barrio, geocache) {
  const query = `${street}, ${barrio.replace(/-/g, " ")}, Ciudad Autonoma de Buenos Aires, Argentina`;
  const key = query.toLowerCase();
  if (key in geocache) return geocache[key];

  // Nominatim: 1 req/s como maximo. Como casi todo sale del cache, esto pega poco.
  await new Promise((r) => setTimeout(r, 1100));
  let coords = null;
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ar&q=" +
      encodeURIComponent(query);
    const res = await fetch(url, { headers: { "User-Agent": NOMINATIM_UA } });
    if (res.ok) {
      const arr = await res.json();
      if (arr[0]) coords = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
    } else {
      console.error(`[nominatim] HTTP ${res.status} para "${query}"`);
    }
  } catch (err) {
    console.error(`[nominatim] error para "${query}": ${err.message}`);
  }

  geocache[key] = coords; // guarda tambien los null: no reintenta direcciones que no resuelven
  geocacheDirty = true;
  return coords;
}

// --- MercadoLibre ---

function buildMLUrl(barrio, desde) {
  const base = `https://inmuebles.mercadolibre.com.ar/cocheras/alquiler/capital-federal/${barrio}/`;
  return desde ? `${base}_Desde_${desde}` : base;
}

function parseMLCards(html, barrio) {
  const $ = cheerio.load(html);
  const listings = [];

  $("li.ui-search-layout__item").each((_, el) => {
    const card = $(el);
    const titleEl = card.find("a.poly-component__title").first();
    const title = titleEl.text().trim();
    const link = (titleEl.attr("href") || "").split("#")[0].split("?")[0];
    if (!title || !link) return;

    const idMatch = link.match(/MLA-?(\d+)/);
    const id = idMatch ? `MLA${idMatch[1]}` : link;

    const priceAria = card
      .find(".poly-price__current .andes-money-amount")
      .first()
      .attr("aria-label") || "";
    const priceDigits = priceAria.replace(/[^\d]/g, "");
    const price = priceDigits ? parseInt(priceDigits, 10) : null;
    const priceCurrency = /d[oó]lar/i.test(priceAria) ? "USD" : "ARS";

    const locationRaw = card.find(".poly-component__location").first().text().trim();
    const areaText = card
      .find(".poly-component__attributes-list li, .poly-attributes-list__item, .poly-component__attributes-list span")
      .map((_i, e) => $(e).text().trim())
      .get()
      .find((t) => /m²/.test(t)) || "";
    const image =
      card.find(".poly-component__picture").first().attr("src") ||
      card.find(".poly-component__picture").first().attr("data-src") ||
      null;

    listings.push({
      id,
      title,
      link,
      price,
      priceCurrency,
      areaText,
      locationRaw,
      barrio,
      image,
    });
  });

  return listings;
}

async function fetchMLBarrio(barrio) {
  const all = [];
  for (const desde of [null, 49]) {
    const url = buildMLUrl(barrio, desde);
    let html;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "es-AR,es;q=0.9" },
      });
      if (!res.ok) {
        if (desde) break; // pagina 2 que no existe: normal
        console.error(`[ml:${barrio}] HTTP ${res.status}`);
        break;
      }
      html = await res.text();
    } catch (err) {
      console.error(`[ml:${barrio}] error: ${err.message}`);
      break;
    }
    const page = parseMLCards(html, barrio);
    all.push(...page);
    if (page.length < 48) break; // no hay mas paginas
    await new Promise((r) => setTimeout(r, 500));
  }
  // dedupe intra-barrio
  return Array.from(new Map(all.map((l) => [l.id, l])).values());
}

// --- Filtros de dominio ---

const NON_COCHERA = /(departamento|\bdepto\b|\bph\b|\bcasa\b|oficina|\blocal\b|fondo de comercio|terreno|\blote\b|galp[oó]n|dep[oó]sito)/i;
// La categoria de ML es "cocheras" pero se cuelan propiedades mal clasificadas
// ("Excelente Propiedad 145 m2"). Se exige senal positiva de cochera o un area chica.
const COCHERA_POS = /(cochera|garage|garaje|estacionamiento|guarda\s?coche|baulera|espacio guarda)/i;
const MOTO = /\bmoto(s|cicleta)?\b/i;
const AUTO_OK = /\b(auto|autom[oó]vil|camioneta|4x4|suv|veh[ií]culo|coche)\b/i;

// area en m2 del texto "25 m² cubiertos" -> 25 (o null)
function areaM2(listing) {
  const m = listing.areaText.match(/(\d+)\s*m²/);
  return m ? parseInt(m[1], 10) : null;
}

// true si el aviso es claramente solo para moto (y no menciona auto).
function isMotoOnly(listing) {
  const t = `${listing.title} ${listing.areaText}`;
  if (!MOTO.test(t)) return false;
  return !AUTO_OK.test(t);
}

function passesBasics(listing) {
  if (NON_COCHERA.test(listing.title)) return false;
  // Cochera de verdad: lo dice el titulo, o el area es chica (<= 40 m²).
  const area = areaM2(listing);
  if (!COCHERA_POS.test(listing.title) && !(area != null && area <= 40)) return false;
  // Ninguna cochera real tiene 60 m²: si aparece, es una propiedad mal categorizada.
  if (area != null && area > 60) return false;
  if (isMotoOnly(listing)) return false;
  if (listing.price == null) return false;
  // USD en cocheras es rarisimo y no tenemos cotizacion cargada aca: se descarta
  // para no comparar mal contra un eventual tope de precio.
  if (listing.priceCurrency !== "ARS") return false;
  if (PRICE_MAX_ARS != null && listing.price > PRICE_MAX_ARS) return false;
  return true;
}

// --- Telegram ---

function formatMoney(n) {
  return "$" + n.toLocaleString("es-AR");
}

function formatCaption(listing) {
  const lines = [];
  lines.push(`🅿️ ${listing.title}`);
  const bits = [formatMoney(listing.price)];
  if (listing.areaText) bits.push(listing.areaText);
  lines.push(bits.join(" · "));

  if (listing.distanceM != null) {
    const cuadras = Math.max(1, Math.round(listing.distanceM / METERS_PER_BLOCK));
    lines.push(`📍 ${listing.locationRaw.split(",").slice(0, 2).join(",").trim()} — a ~${cuadras} cuadra${cuadras === 1 ? "" : "s"} (${Math.round(listing.distanceM)} m)`);
  } else {
    lines.push(`📍 ${listing.locationRaw} — ⚠️ sin dirección exacta, puede estar fuera del radio`);
  }

  lines.push(listing.link);
  return lines.join("\n").slice(0, 1024);
}

async function sendPhoto(chatId, photoUrl, caption) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendMessage(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    });
    if (!res.ok) console.error(`[telegram] sendMessage ${res.status} (chat ${chatId}): ${await res.text()}`);
  } catch (err) {
    console.error(`[telegram] sendMessage error (chat ${chatId}): ${err.message}`);
  }
}

async function sendListing(chatId, listing, formatter) {
  const caption = (formatter || formatCaption)(listing);
  if (listing.image && (await sendPhoto(chatId, listing.image, caption))) return;
  await sendMessage(chatId, caption); // fallback sin foto
}

// --- Deptos con cochera (MercadoLibre) ---
// Distinto de la busqueda de cocheras: aca son barrios enteros (no radio de 5
// cuadras), alquiler <= $750.000 total CON cochera incluida, en Villa Crespo /
// Almagro / Palermo. Se combina el filtro estructurado de ML (_Cocheras_1) con
// los avisos que mencionan cochera en el titulo pero no tildaron el atributo.

const DEPTO_BARRIOS = ["villa-crespo", "almagro", "palermo"];
const DEPTO_PRICE_MAX_ARS = 750_000;
const DEPTO_COCHERA = /\bcocheras?\b|\bgarages?\b|\bgaraje\b/i;
const DEPTO_SIN_COCHERA = /sin cochera|no incluye cochera|sin garage/i;
const DEPTO_DESCARTE = /\bventa\b|temporari[oa]|temporal/i;

function buildDeptoUrl(barrio, conCochera, desde) {
  let u = `https://inmuebles.mercadolibre.com.ar/departamentos/alquiler/capital-federal/${barrio}/_PriceRange_0ARS-${DEPTO_PRICE_MAX_ARS}ARS`;
  if (conCochera) u += "_Cocheras_1";
  if (desde) u += `_Desde_${desde}`;
  return u;
}

function parseDeptoCards(html, barrio, fromCocheraFacet) {
  const $ = cheerio.load(html);
  const out = [];
  $("li.ui-search-layout__item").each((_, el) => {
    const card = $(el);
    const titleEl = card.find("a.poly-component__title").first();
    const title = titleEl.text().trim();
    const link = (titleEl.attr("href") || "").split("#")[0].split("?")[0];
    if (!title || !link) return;
    const idMatch = link.match(/MLA-?(\d+)/);
    const id = idMatch ? `MLA${idMatch[1]}` : link;

    const priceAria =
      card.find(".poly-price__current .andes-money-amount").first().attr("aria-label") || "";
    const priceDigits = priceAria.replace(/[^\d]/g, "");
    const price = priceDigits ? parseInt(priceDigits, 10) : null;
    const priceCurrency = /d[oó]lar/i.test(priceAria) ? "USD" : "ARS";

    const locationRaw = card.find(".poly-component__location").first().text().trim();
    const attrsText = card
      .find(".poly-component__attributes-list li, .poly-attributes-list__item, .poly-component__attributes-list span")
      .map((_i, e) => $(e).text().trim())
      .get()
      .join(" · ");
    const image =
      card.find(".poly-component__picture").first().attr("src") ||
      card.find(".poly-component__picture").first().attr("data-src") ||
      null;

    out.push({ id, title, link, price, priceCurrency, locationRaw, attrsText, barrio, image, fromCocheraFacet });
  });
  return out;
}

async function fetchDeptosBarrio(barrio) {
  const all = [];
  for (const conCochera of [true, false]) {
    for (const desde of [null, 49]) {
      const url = buildDeptoUrl(barrio, conCochera, desde);
      let html;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, "Accept-Language": "es-AR,es;q=0.9" },
        });
        if (!res.ok) {
          if (!desde) console.error(`[ml-depto:${barrio}${conCochera ? ":coch" : ""}] HTTP ${res.status}`);
          break;
        }
        html = await res.text();
      } catch (err) {
        console.error(`[ml-depto:${barrio}] error: ${err.message}`);
        break;
      }
      const page = parseDeptoCards(html, barrio, conCochera);
      all.push(...page);
      if (page.length < 48) break; // no hay mas paginas
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return all;
}

function deptoPasa(d) {
  if (d.price == null) return false;
  if (d.priceCurrency !== "ARS") return false; // ventas en USD que se cuelan en alquiler
  if (d.price > DEPTO_PRICE_MAX_ARS) return false;
  if (DEPTO_DESCARTE.test(d.title)) return false; // venta / temporario
  const txt = `${d.title} ${d.attrsText}`;
  if (DEPTO_SIN_COCHERA.test(txt)) return false;
  // Con cochera: vino del filtro estructurado de ML, o lo dice el titulo/atributos.
  return d.fromCocheraFacet || DEPTO_COCHERA.test(txt);
}

function formatDeptoCaption(d) {
  const lines = [];
  lines.push(`🏠 ${d.title}`);
  const bits = [formatMoney(d.price)];
  if (d.attrsText) bits.push(d.attrsText);
  lines.push(bits.join(" · "));
  lines.push(`📍 ${d.locationRaw.split(",").slice(0, 2).join(",").trim()}`);
  lines.push(d.link);
  return lines.join("\n").slice(0, 1024);
}

async function findDeptosFresh(sentIds) {
  const raw = [];
  for (const barrio of DEPTO_BARRIOS) {
    raw.push(...(await fetchDeptosBarrio(barrio)));
    await new Promise((r) => setTimeout(r, 500));
  }
  // dedupe: un mismo aviso aparece en el fetch con y sin _Cocheras_1
  const byId = new Map();
  for (const d of raw) {
    const prev = byId.get(d.id);
    if (!prev) byId.set(d.id, d);
    else if (d.fromCocheraFacet) prev.fromCocheraFacet = true; // conservar la senal
  }
  const ok = [...byId.values()].filter(deptoPasa);
  const fresh = ok.filter((d) => !sentIds[d.id]);
  fresh.sort((a, b) => a.price - b.price);
  return { fresh, total: byId.size, ok: ok.length };
}

// --- Cocheras: buscar las nuevas dentro del radio ---

async function findCocherasFresh(sentIds, geocache) {
  // 1. Traer todos los avisos de ML de los barrios candidatos.
  const raw = [];
  for (const barrio of BARRIOS) {
    raw.push(...(await fetchMLBarrio(barrio)));
    await new Promise((r) => setTimeout(r, 500)); // educado con ML
  }
  const byId = Array.from(new Map(raw.map((l) => [l.id, l])).values());

  // 2. Filtro basico (cochera de auto, precio en ARS).
  const candidates = byId.filter(passesBasics);

  // 3. Geo: geocodificar y quedarse con lo que esta dentro del radio.
  const inRadius = [];
  for (const listing of candidates) {
    const street = parseStreet(listing.locationRaw);
    if (!street) {
      if (/villa crespo/i.test(listing.locationRaw)) {
        listing.distanceM = null;
        inRadius.push(listing);
      }
      continue;
    }
    const coords = await geocode(street, listing.barrio, geocache);
    if (!coords) {
      if (/villa crespo/i.test(listing.locationRaw)) {
        listing.distanceM = null;
        inRadius.push(listing);
      }
      continue;
    }
    const d = haversineM(HOME, coords);
    if (d <= RADIUS_M) {
      listing.distanceM = d;
      inRadius.push(listing);
    }
  }

  // 4. Nuevos (no avisados antes).
  const fresh = inRadius.filter((l) => !sentIds[l.id]);
  fresh.sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
  return { fresh, total: byId.length, candidates: candidates.length, inRadius: inRadius.length };
}

// --- Main ---

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  if (!dryRun && !TELEGRAM_TOKEN) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN en el entorno.");
  }

  const sentIds = loadJson(STATE_FILE, {});
  const geocache = loadJson(GEOCACHE_FILE, {});

  const coch = await findCocherasFresh(sentIds, geocache);
  if (geocacheDirty) saveJson(GEOCACHE_FILE, geocache);
  const dep = await findDeptosFresh(sentIds);

  if (dryRun) {
    console.log(`[DRY RUN] cocheras: ${coch.total} avisos ML, ${coch.candidates} tras filtro, ${coch.inRadius} en radio, ${coch.fresh.length} nuevas:\n`);
    for (const m of coch.fresh) console.log(formatCaption(m) + "\n---");
    console.log(`\n[DRY RUN] deptos con cochera: ${dep.total} avisos, ${dep.ok} cumplen (<= ${formatMoney(DEPTO_PRICE_MAX_ARS)}, con cochera), ${dep.fresh.length} nuevos:\n`);
    for (const d of dep.fresh) console.log(formatDeptoCaption(d) + "\n---");
    return;
  }

  const chatIds = new Set(loadRecipients());
  if (TELEGRAM_CHAT_ID) chatIds.add(String(TELEGRAM_CHAT_ID));

  if (coch.fresh.length === 0 && dep.fresh.length === 0) {
    console.log("Sin cocheras ni deptos nuevos en esta corrida.");
    saveJson(STATE_FILE, sentIds);
    return;
  }

  for (const chatId of chatIds) {
    if (coch.fresh.length) {
      await sendMessage(chatId, `🅿️ ${coch.fresh.length} cochera(s) nueva(s) para auto a <= 5 cuadras de Corrientes 5753:`);
      for (const m of coch.fresh) {
        await sendListing(chatId, m);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (dep.fresh.length) {
      await sendMessage(
        chatId,
        `🏠 ${dep.fresh.length} depto(s) con cochera nuevo(s) hasta ${formatMoney(DEPTO_PRICE_MAX_ARS)} en Villa Crespo / Almagro / Palermo:`
      );
      for (const d of dep.fresh) {
        await sendListing(chatId, d, formatDeptoCaption);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  for (const m of coch.fresh) sentIds[m.id] = new Date().toISOString();
  for (const d of dep.fresh) sentIds[d.id] = new Date().toISOString();
  saveJson(STATE_FILE, sentIds);
  console.log(`Enviadas ${coch.fresh.length} cocheras + ${dep.fresh.length} deptos a ${chatIds.size} destinatario(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
