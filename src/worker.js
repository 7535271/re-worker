/* ──────────────────────────────────────────
   RE: — probe worker
   CMC を実際に叩いて、生のレスポンスをそのまま返す。
   推測ではなく実データを仕様にするための確認用。
   キーは Secrets の CMC_KEY にだけ置く。画面には出ない。
   ────────────────────────────────────────── */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CMC = "https://pro-api.coinmarketcap.com";

function out(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

// CMC を叩いて、request と response をまるごと記録して返す
async function hit(env, path, params) {
  const url = new URL(CMC + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const started = new Date().toISOString();
  let status, body;
  try {
    const r = await fetch(url.toString(), {
      headers: { "X-CMC_PRO_API_KEY": env.CMC_KEY, Accept: "application/json" },
    });
    status = r.status;
    const text = await r.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { _unparsed: text.slice(0, 2000) };
    }
  } catch (e) {
    status = -1;
    body = { _fetch_error: String(e && e.message ? e.message : e) };
  }
  // キーがURLに混ざらないよう、記録用URLからは除外（ヘッダー認証なので元々入っていない）
  return {
    request: {
      endpoint: path,
      params,
      url: url.toString(),
      at: started,
    },
    response: {
      http_status: status,
      // CMC は status.credit_count / error_code をここに入れてくる
      status: body && body.status ? body.status : null,
      // データ本体はそのまま。ただし巨大になりすぎないよう軽く要約も添える
      data: body && "data" in body ? body.data : body,
    },
  };
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const p = url.pathname;

    if (!env.CMC_KEY) {
      return out({ error: "CMC_KEY not set in Secrets" }, 400);
    }

    try {
      // 入口。何が叩けるかの一覧
      if (p === "/" || p === "") {
        return out({
          probes: [
            "/probe/btc   → 2020-03 BTC daily historical quotes（最重要）",
            "/probe/ohlcv → 2020-03 BTC daily OHLCV（volatility の素材）",
            "/probe/fng   → Fear & Greed historical（最古 timestamp を見る）",
            "/probe/all   → 上を全部まとめて",
          ],
        });
      }

      // ① 2020-03 BTC daily — Startup で 2010年まで遡れるかの実測
      if (p === "/probe/btc") {
        const r = await hit(env, "/v3/cryptocurrency/quotes/historical", {
          symbol: "BTC",
          time_start: "2020-03-01",
          time_end: "2020-03-31",
          interval: "daily",
          convert: "USD",
        });
        return out(r);
      }

      // ② 2020-03 BTC daily OHLCV — high/low があれば volatility をコード計算できる
      if (p === "/probe/ohlcv") {
        const r = await hit(env, "/v2/cryptocurrency/ohlcv/historical", {
          symbol: "BTC",
          time_start: "2020-03-01",
          time_end: "2020-03-31",
          interval: "daily",
          convert: "USD",
        });
        return out(r);
      }

      // ③ Fear & Greed historical — 何年まで遡れるか。count 大きめで最古を探る
      if (p === "/probe/fng") {
        const r = await hit(env, "/v3/fear-and-greed/historical", {
          start: 1,
          limit: 500,
        });
        // 最古と最新の timestamp だけ抜き出して見やすくする
        let oldest = null,
          newest = null,
          n = 0;
        const d = r.response.data;
        if (Array.isArray(d) && d.length) {
          n = d.length;
          const stamp = (x) => x.timestamp || x.update_time || x.time || null;
          oldest = stamp(d[d.length - 1]);
          newest = stamp(d[0]);
        }
        return out({ ...r, _summary: { count: n, oldest, newest } });
      }

      // 全部まとめて
      if (p === "/probe/all") {
        const [btc, ohlcv, fng] = await Promise.all([
          hit(env, "/v3/cryptocurrency/quotes/historical", {
            symbol: "BTC",
            time_start: "2020-03-01",
            time_end: "2020-03-31",
            interval: "daily",
            convert: "USD",
          }),
          hit(env, "/v2/cryptocurrency/ohlcv/historical", {
            symbol: "BTC",
            time_start: "2020-03-01",
            time_end: "2020-03-31",
            interval: "daily",
            convert: "USD",
          }),
          hit(env, "/v3/fear-and-greed/historical", { start: 1, limit: 500 }),
        ]);
        return out({ btc, ohlcv, fng });
      }

      return out({ error: "not found", try: "/" }, 404);
    } catch (e) {
      return out({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
