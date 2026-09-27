#!/usr/bin/env python3
# Распаковка архива ФНС в stdout для scripts/fns-import.mjs — вместо `unzip -p`.
# Каждый файл архива читается целиком и проверяется по контрольной сумме до того, как попасть в вывод,
# поэтому битый файл не оставит в данных обрывок XML: он пропускается, а в stderr пишется, какой и почему.
# Последняя строка stderr — итог: «ИТОГО файлов N, битых M». Код выхода: 0 — всё цело, 3 — битых не больше
# 1% (данные годятся), 4 — битых больше или архив не читается вовсе.
# Запуск: python3 scripts/unzip-stream.py архив.zip > данные.xml
import sys
import zipfile

MAX_BAD_SHARE = 0.01


def main(path):
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        print(f"архив не читается: {e}", file=sys.stderr)
        print("ИТОГО файлов 0, битых 0", file=sys.stderr)
        return 4
    entries = [i for i in z.infolist() if not i.is_dir()]
    bad = 0
    out = sys.stdout.buffer
    for info in entries:
        try:
            data = z.read(info)          # проверяет контрольную сумму файла
        except Exception as e:          # любая порча одного файла (контрольная сумма, заголовок, zlib) — пропускаем его
            bad += 1
            if bad <= 20:
                print(f"битый файл {info.filename} (смещение {info.header_offset}): {e}", file=sys.stderr)
            continue
        out.write(data)
    out.flush()
    print(f"ИТОГО файлов {len(entries)}, битых {bad}", file=sys.stderr)
    if bad == 0:
        return 0
    return 3 if bad <= len(entries) * MAX_BAD_SHARE else 4


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1]))
    except BrokenPipeError:        # импорт остановился раньше и закрыл канал
        sys.exit(1)
