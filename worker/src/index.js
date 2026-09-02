// Dos responsabilidades:
//  - scheduled(): el cron real del bot. El schedule nativo de GitHub Actions no es
//    confiable en repos nuevos, asi que un Cron Trigger de Cloudflare dispara el
//    workflow por la API de GitHub cada 30 min.
//  - fetch(): webhook de Telegram. Responde /cercanas, /start y /help al instante.
//
// Nota: con webhook registrado, `getUpdates` deja de funcionar (Telegram no permite
// las dos cosas). Por eso el scraper ya NO hace polling de getUpdates; los
// destinatarios salen de TELEGRAM_CHAT_ID + chat_ids.json.

const GITHUB_REPO = "enginecpu1-cyber/bot-cocheras-caba";
const GITHUB_WORKFLOW = "buscar-cocheras.yml";

async function dispatchGitHubWorkflow(env) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "bot-cocheras-caba-cron",
      },
      body: JSON.stringify({ ref: "master" }),
    }
  );
  if (!res.ok) {
    console.error(`GitHub dispatch error ${res.status}: ${await res.text()}`);
  }
}

// Garages comerciales a <= 5 cuadras de Av. Corrientes 5753 (Villa Crespo).
// Relevados de Google Maps el 2026-09-02; distancia verificada geocodificando cada
// direccion contra la casa. Casi todos alquilan por mes ("estadia mensual") aunque
// no lo publiquen: hay que preguntar por telefono.
const CERCANAS = [
  { n: "Garage / Parking JorMar",        a: "Thames 539",          d: "82 m (~1 cuadra)",  r: "3,1★ (57)",   t: "011 7972-4000",       h: "24 hs" },
  { n: "Garage Corrientes 5671",         a: "Av. Corrientes 5671",  d: "97 m (~1 cuadra)",  r: "4,0★ (42)",   t: "011 15-7223-4380",    h: "24 hs" },
  { n: "Garage Corrientes 5659",         a: "Av. Corrientes 5659",  d: "110 m (~1 cuadra)", r: "sin reseñas", t: "—",                   h: "—" },
  { n: "Estacionamiento El Triunfo SRL", a: "Av. Corrientes 5850",  d: "115 m (~1 cuadra)", r: "2,8★ (91)",   t: "011 4857-5300",       h: "24 hs" },
  { n: "Garage Darwin 549",              a: "Darwin 545",           d: "179 m (~2 cuadras)",r: "4,0★ (6)",    t: "—",                   h: "—" },
  { n: "Parking CAMARGO",                a: "Camargo 953",          d: "187 m (~2 cuadras)",r: "4,7★ (551)",  t: "011 3400-3100",       h: "24 hs" },
  { n: "Garage Serrano",                 a: "Serrano 546",          d: "194 m (~2 cuadras)",r: "3,2★ (50)",   t: "—",                   h: "24 hs" },
  { n: "Garage Camargo",                 a: "Camargo 1251",         d: "261 m (~2 cuadras)",r: "2,6★ (28)",   t: "011 3552-9160",       h: "cierra 23 h" },
  { n: "Parking Velazco",                a: "J. R. de Velasco 1418",d: "434 m (~4 cuadras)",r: "3,7★ (113)",  t: "011 3563-1343",       h: "24 hs" },
];

function cercanasText() {
  const lines = ["🅿️ *Cocheras a ≤5 cuadras de Corrientes 5753*", "_Google Maps · para abono mensual conviene llamar y preguntar._", ""];
  for (const g of CERCANAS) {
    lines.push(`*${g.n}* — ${g.a}`);
    lines.push(`${g.d} · ${g.r}${g.t !== "—" ? ` · 📞 ${g.t}` : ""}${g.h !== "—" ? ` · ${g.h}` : ""}`);
    lines.push("");
  }
  lines.push("Mejor puntuados: Parking CAMARGO (4,7), Garage Corrientes 5671 (4,0).");
  return lines.join("\n");
}

const HELP =
  "Soy el bot de cocheras de Villa Crespo.\n\n" +
  "Te aviso solo cuando aparece una cochera para auto en alquiler a ≤5 cuadras de Corrientes 5753.\n\n" +
  "/cercanas — lista de garages comerciales de la zona con teléfono (para preguntar por abono mensual)";

async function tgSend(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
}

async function handleUpdate(env, update) {
  const msg = update.message || update.edited_message;
  const text = (msg && msg.text ? msg.text : "").trim().toLowerCase();
  if (!msg || !text) return;

  // /cercanas, /start, /help — aceptando el sufijo @nombre_bot
  const cmd = text.split(/\s+/)[0].replace(/@[a-z0-9_]+$/i, "");
  if (cmd === "/cercanas") {
    await tgSend(env, msg.chat.id, cercanasText());
  } else if (cmd === "/start" || cmd === "/help") {
    await tgSend(env, msg.chat.id, HELP);
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok", { status: 200 });

    if (
      env.WEBHOOK_SECRET &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
    ) {
      return new Response("unauthorized", { status: 401 });
    }

    try {
      await handleUpdate(env, await request.json());
    } catch (err) {
      console.error(err);
    }
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchGitHubWorkflow(env));
  },
};
