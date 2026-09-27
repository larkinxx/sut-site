# Часовой прогноз фьючерса Мосбиржи моделью TimesFM 2.5 и проверка по истории: цена и волатильность.
# Данные — бесплатный API биржи (iss.moex.com), часовые свечи. По умолчанию вечный фьючерс USDRUBF (аналог Si без
# экспирации, склейка контрактов не нужна); другие вечные: CNYRUBF, EURRUBF, IMOEXF, GLDRUBF. У квартального
# контракта (например SiZ6) история — только одна серия, для долгой проверки её мало.
# Волатильность часа — ln(high/low) свечи; прогнозируется её среднее за следующие --horizon часов.
# Лежит рядом с forecast.py и берёт из него загрузку модели.
# Запуск: python futures_forecast.py [--secid USDRUBF] [--horizon 14] [--backtest 100] [--out futures.json]
# Это исследование, а не торговая рекомендация: издержки и проскальзывание здесь не учитываются.
import argparse
import datetime as dt
import json
import pathlib
import urllib.request

import numpy as np

from forecast import load_model, run_forecast

ISS = "https://iss.moex.com/iss/engines/futures/markets/forts/securities"
UA = {"User-Agent": "Mozilla/5.0 (sut-site futures forecast)"}


def fetch_candles(secid, start, end):
  """Часовые свечи [(начало, open, high, low, close)] по возрастанию времени; ISS отдаёт по 500 строк за запрос."""
  rows, offset = {}, 0
  while True:
    url = f"{ISS}/{secid}/candles.json?interval=60&from={start:%Y-%m-%d}&till={end:%Y-%m-%d}&start={offset}&iss.meta=off"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
      block = json.load(r)["candles"]
    if not block["data"]:
      break
    for rec in block["data"]:
      c = dict(zip(block["columns"], rec))
      if c["high"] and c["low"] and c["close"]:
        rows[c["begin"]] = (c["begin"], float(c["open"]), float(c["high"]), float(c["low"]), float(c["close"]))
    offset += len(block["data"])
  return [rows[k] for k in sorted(rows)]


def origins(n, horizon, runs, min_context):
  """Точки старта прогнозов из прошлого с шагом horizon; последняя — horizon свечей назад."""
  return [n - k * horizon for k in range(runs, 0, -1) if n - k * horizon >= min_context]


def ewma(x, span):
  a, s = 2 / (span + 1), x[0]
  for v in x[1:]:
    s = a * v + (1 - a) * s
  return s


def main():
  ap = argparse.ArgumentParser(description=__doc__)
  ap.add_argument("--secid", default="USDRUBF", help="код фьючерса на Мосбирже")
  ap.add_argument("--horizon", type=int, default=14, help="на сколько часовых свечей вперёд (14 ≈ торговый день)")
  ap.add_argument("--days", type=int, default=730, help="сколько календарных дней истории брать")
  ap.add_argument("--context", type=int, default=1024, help="сколько последних свечей видит модель")
  ap.add_argument("--backtest", type=int, default=100, metavar="N", help="сколько прогнозов из прошлого проверить (0 — без проверки)")
  ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("futures.json"), help="куда сохранить JSON")
  args = ap.parse_args()
  h = args.horizon

  today = dt.date.today()
  candles = fetch_candles(args.secid, today - dt.timedelta(days=args.days), today)
  if len(candles) < 300:
    raise SystemExit(f"{args.secid}: с iss.moex.com пришло всего {len(candles)} свечей — мало для прогноза")
  times = [c[0] for c in candles]
  close = np.array([c[4] for c in candles], dtype=np.float32)
  vol = np.log(np.array([c[2] for c in candles]) / np.array([c[3] for c in candles])).astype(np.float32) * 100  # размах часа, %
  print(f"{args.secid}: {len(candles)} часовых свечей, {times[0]} — {times[-1]}")

  model = load_model(args.context, h)
  ctx = lambda x, t: x[max(0, t - args.context):t]
  n = len(close)
  starts = origins(n, h, args.backtest, min_context=200)
  # Один проход модели: сначала прогноз «сейчас», потом все прогнозы из прошлого; цена и волатильность вместе
  point, lo, hi = run_forecast(model, [ctx(close, n), ctx(vol, n)] + [ctx(close, t) for t in starts] + [ctx(vol, t) for t in starts], h)

  last = float(close[-1])
  p_now, v_now, v_recent = float(point[0, -1]), float(point[1].mean()), float(vol[-h:].mean())
  print(
    f"Цена: {last:.2f} → {p_now:.2f} через {h} ч ({(p_now / last - 1) * 100:+.2f}%), интервал 80%: {lo[0, -1]:.2f}–{hi[0, -1]:.2f}\n"
    f"Волатильность (средний размах часа): прогноз {v_now:.3f}%, за последние {h} ч было {v_recent:.3f}%"
  )
  result = {
    "_note": "TimesFM 2.5 по часовым свечам Мосбиржи. Исследование, не торговая рекомендация.",
    "secid": args.secid,
    "createdAt": today.isoformat(),
    "lastCandle": times[-1],
    "horizonHours": h,
    "price": {"last": round(last, 4), "forecast": [round(float(x), 4) for x in point[0]],
              "low80": [round(float(x), 4) for x in lo[0]], "high80": [round(float(x), 4) for x in hi[0]]},
    "volatility": {"recent": round(v_recent, 4), "forecast": [round(float(x), 4) for x in point[1]]},
  }

  if starts:
    k = len(starts)
    p_idx, v_idx = slice(2, 2 + k), slice(2 + k, 2 + 2 * k)
    s = np.array(starts)
    # Цена: конец горизонта против «цена не изменится»
    fact, base = close[s + h - 1], close[s - 1]
    pred, low, high = point[p_idx, -1], lo[p_idx, -1], hi[p_idx, -1]
    err_m, err_n = np.abs(pred / fact - 1) * 100, np.abs(base / fact - 1) * 100
    moved = fact != base
    direction = float((np.sign(pred - base) == np.sign(fact - base))[moved].mean() * 100) if moved.any() else float("nan")
    # Волатильность: средний размах следующих h часов против «как последние h часов» и EWMA
    v_fact = np.array([vol[t:t + h].mean() for t in starts])
    v_pred = point[v_idx].mean(axis=1)
    v_naive = np.array([vol[t - h:t].mean() for t in starts])
    v_ewma = np.array([ewma(vol[max(0, t - 5 * h):t], span=5 * h) for t in starts])
    ev_m, ev_n, ev_e = (np.abs(x / v_fact - 1) * 100 for x in (v_pred, v_naive, v_ewma))

    print(f"\nПроверка по истории: {k} прогнозов на {h} ч, с {times[starts[0]]} по {times[-1]}")
    print(
      f"Цена: ошибка TimesFM {err_m.mean():.2f}%, «не изменится» {err_n.mean():.2f}%; TimesFM точнее в {(err_m < err_n).sum()} из {k}; "
      f"направление угадано в {direction:.0f}% случаев; факт внутри интервала 80% — в {((fact >= low) & (fact <= high)).mean() * 100:.0f}%"
    )
    print(
      f"Волатильность: ошибка TimesFM {ev_m.mean():.1f}%, «как последние {h} ч» {ev_n.mean():.1f}%, EWMA {ev_e.mean():.1f}%; "
      f"TimesFM точнее обоих в {((ev_m < ev_n) & (ev_m < ev_e)).sum()} из {k}"
    )
    result["backtest"] = {
      "runs": k,
      "price": {"mapeModel": round(float(err_m.mean()), 3), "mapeNaive": round(float(err_n.mean()), 3),
                "modelBetter": int((err_m < err_n).sum()), "directionHit": round(direction, 1),
                "coverage80": round(float(((fact >= low) & (fact <= high)).mean() * 100), 1)},
      "volatility": {"errModel": round(float(ev_m.mean()), 2), "errNaive": round(float(ev_n.mean()), 2),
                     "errEwma": round(float(ev_e.mean()), 2), "modelBest": int(((ev_m < ev_n) & (ev_m < ev_e)).sum())},
      "cases": [
        {"from": times[t - 1], "price": {"last": round(float(b), 4), "forecast": round(float(p), 4), "fact": round(float(f), 4)},
         "volatility": {"forecast": round(float(vp), 4), "fact": round(float(vf), 4)}}
        for t, b, p, f, vp, vf in zip(starts, base, pred, fact, v_pred, v_fact)
      ],
    }

  args.out.parent.mkdir(parents=True, exist_ok=True)
  args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
  print(f"Сохранено: {args.out}")


if __name__ == "__main__":
  main()
