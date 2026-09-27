# Прогноз официальных курсов валют ЦБ на ближайший месяц моделью Google TimesFM 2.5.
# Берёт историю курсов с cbr.ru за 3 года, прогнозирует на 22 рабочих дня вперёд (≈ месяц),
# печатает таблицу и сохраняет content/forecast.json. Модель — TimesFM 2.5 (веса Apache-2.0, можно
# использовать на сайте; веса TimesFM 3.0 пока только для некоммерческого использования).
# Установка: pip install "timesfm[torch]"   Запуск: python scripts/forecast.py [--horizon 22]
# Это статистический прогноз, а не инвестиционная рекомендация: он не знает о будущих решениях ЦБ и событиях.
import argparse
import datetime as dt
import json
import pathlib
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "content" / "forecast.json"
CURRENCIES = {"USD": "R01235", "EUR": "R01239", "CNY": "R01375"}
UA = {"User-Agent": "Mozilla/5.0 (sut-site forecast)"}


def fetch_rates(code, start, end):
  """Курс валюты по дням из XML-сервиса ЦБ: [(дата, рублей за 1 единицу)]."""
  url = (
    "https://www.cbr.ru/scripts/XML_dynamic.asp"
    f"?date_req1={start:%d/%m/%Y}&date_req2={end:%d/%m/%Y}&VAL_NM_RQ={code}"
  )
  with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
    return parse_rates(r.read())


def parse_rates(xml_bytes):
  rows = []
  for rec in ET.fromstring(xml_bytes).iter("Record"):
    date = dt.datetime.strptime(rec.get("Date"), "%d.%m.%Y").date()
    nominal = float(rec.findtext("Nominal").replace(",", "."))
    value = float(rec.findtext("Value").replace(",", "."))
    rows.append((date, value / nominal))
  return sorted(rows)


def business_days_after(day, n):
  """Следующие n рабочих дней (пн–пт); праздники ЦБ не учитываются."""
  out = []
  while len(out) < n:
    day += dt.timedelta(days=1)
    if day.weekday() < 5:
      out.append(day)
  return out


def load_model(max_context, horizon):
  import timesfm
  import torch

  torch.set_float32_matmul_precision("high")
  model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
  model.compile(
    timesfm.ForecastConfig(
      max_context=max_context,
      max_horizon=horizon,
      normalize_inputs=True,
      use_continuous_quantile_head=True,
      force_flip_invariance=True,
      infer_is_positive=True,
      fix_quantile_crossing=True,
    )
  )
  return model


def main():
  ap = argparse.ArgumentParser(description=__doc__)
  ap.add_argument("--horizon", type=int, default=22, help="на сколько рабочих дней вперёд")
  ap.add_argument("--years", type=int, default=3, help="сколько лет истории брать")
  args = ap.parse_args()

  today = dt.date.today()
  history = {
    cur: fetch_rates(code, today - dt.timedelta(days=365 * args.years), today)
    for cur, code in CURRENCIES.items()
  }
  for cur, rows in history.items():
    if len(rows) < 100:
      raise SystemExit(f"{cur}: с cbr.ru пришло всего {len(rows)} значений — прогноз не строю")

  max_context = 1024  # ≈ 4 года рабочих дней; более длинная история обрезается
  model = load_model(max_context, args.horizon)
  inputs = [np.array([v for _, v in rows], dtype=np.float32)[-max_context:] for rows in history.values()]
  point, quant = model.forecast(horizon=args.horizon, inputs=inputs)
  # quant[..., 0] — среднее, дальше квантили 0.1 … 0.9: берём 0.1 и 0.9 → интервал 80%
  lo, hi = quant[:, :, 1], quant[:, :, 9]

  result = {
    "_note": "Прогноз TimesFM 2.5 по официальным курсам ЦБ. Статистическая модель, не рекомендация.",
    "model": "google/timesfm-2.5-200m-pytorch",
    "createdAt": today.isoformat(),
    "horizonBusinessDays": args.horizon,
    "currencies": {},
  }
  for i, (cur, rows) in enumerate(history.items()):
    last_date, last_value = rows[-1]
    dates = business_days_after(last_date, args.horizon)
    result["currencies"][cur] = {
      "last": {"date": last_date.isoformat(), "value": round(last_value, 4)},
      "forecast": [
        {"date": d.isoformat(), "value": round(float(p), 4), "low80": round(float(l), 4), "high80": round(float(h), 4)}
        for d, p, l, h in zip(dates, point[i], lo[i], hi[i])
      ],
    }
    end = result["currencies"][cur]["forecast"][-1]
    change = (end["value"] / last_value - 1) * 100
    print(
      f"{cur}: {last_value:.2f} ₽ на {last_date:%d.%m.%Y} → {end['value']:.2f} ₽ к {dt.date.fromisoformat(end['date']):%d.%m.%Y} "
      f"({change:+.1f}%), интервал 80%: {end['low80']:.2f}–{end['high80']:.2f} ₽"
    )

  OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
  print(f"Сохранено: {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
  main()
