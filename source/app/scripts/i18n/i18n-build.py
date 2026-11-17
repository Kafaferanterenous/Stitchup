"""Build src/locales/<lang>.json from numbered translation lines, with checks."""
import json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
keys = json.load(open(os.path.join(HERE, 'i18n-keys.json'), encoding='utf-8'))
out_dir = os.path.join(HERE, '..', '..', 'src', 'locales')
ok = True
for lang in sys.argv[1:]:
    rows = {}
    for n, line in enumerate(open(os.path.join(HERE, f'{lang}.txt'), encoding='utf-8'), 1):
        line = line.rstrip('\n')
        if not line.strip():
            continue
        m = re.match(r'^(\d+)\|(.*)$', line)
        if not m:
            print(f'{lang}:{n}: bad line: {line[:60]}'); ok = False; continue
        i, t = int(m.group(1)), m.group(2)
        if i in rows:
            print(f'{lang}: duplicate index {i}'); ok = False
        rows[i] = t
    missing = [i for i in range(len(keys)) if i not in rows]
    extra = [i for i in rows if i >= len(keys)]
    if missing or extra:
        print(f'{lang}: missing {missing[:20]} extra {extra[:20]}'); ok = False
    table = {}
    for i, en in enumerate(keys):
        t = rows.get(i)
        if t is None:
            continue
        # Placeholders: all must survive, except English plural suffixes ("page{1}").
        need = set(re.findall(r'\{\d+\}', en))
        optional = set(re.findall(r'(?<=[A-Za-z])(\{\d+\})', en))
        have = set(re.findall(r'\{\d+\}', t))
        lost = need - optional - have
        bogus = have - need
        if lost or bogus:
            print(f'{lang} #{i}: placeholders lost {lost} bogus {bogus}: {en!r} -> {t!r}'); ok = False
        # Leading / trailing spaces matter in fragments.
        if en.startswith(' ') and not t.startswith(' '):
            t = ' ' + t
        table[en] = t
    json.dump(table, open(f'{out_dir}/{lang}.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0, sort_keys=True)
    print(f'{lang}: {len(table)}/{len(keys)} strings')
sys.exit(0 if ok else 1)
