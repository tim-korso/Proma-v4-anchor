#!/usr/bin/env python3
"""Generic asar file injector: replace N header files with new bytes in one pass.

Layout truth used here (asar v2, single-file):
  file = 4-byte header-size fields + JSON header + NUL padding + concatenated data.
  Every header file entry stores offset/size RELATIVE to data base = 8+headerLen.

Algorithm:
  * sort injections by old data offset ascending,
  * stream the data region once: copy unchanged slices, write replacement bytes
    at the cursor, accumulate delta (new_size - old_size),
  * rewrite every header entry whose data lies at/after a replaced region:
      new_offset = old_offset + (sum of deltas of injections preceding it)
  * replaced entries get fresh size + SHA256 integrity (4MiB blocks),
  * NUL-pad the header to a 4-byte boundary (asar requirement).

Integrity follows asar's own convention (verified against upstream bundle):
  - <=1 file block  -> blocks=[sha256(file)], hash=blocks[0]  (=sha256 of file)
  - >1 file block   -> per-file 4MiB blocks joined, hash=sha256(join(blocks))
        (this is the "joined" style asar uses for large bundle entries such as
         dist/main.cjs; plain sha256-of-file is NOT used there)
The header JSON serialises with compact separators so that replacing entries
whose size/offset digit counts are unchanged keeps the header byte-length
stable (base unchanged). The script works regardless; it always rewrites the
header with correct padding.

Usage:
  python3 scripts/repack-asar-inject.py \
      --asar app.asar \
      --inject /node_modules/@earendil-works/pi-ai/dist/utils/retry.js=/path/to/retry.js \
      --inject /dist/agent-runtime.cjs=apps/electron/dist/agent-runtime.cjs \
      --inject /dist/main.cjs=apps/electron/dist/main.cjs \
      --out /tmp/app.asar.injected
"""
import argparse, hashlib, json, os, struct, sys

BLOCK = 4194304


def integrity_of(data: bytes) -> dict:
    """Mirror asar's native integrity encoding (see module docstring)."""
    blocks = [hashlib.sha256(data[i:i + BLOCK]).hexdigest()
              for i in range(0, len(data), BLOCK)]
    digest = (hashlib.sha256(''.join(blocks).encode()).hexdigest()
              if len(blocks) > 1 else blocks[0])
    return {"algorithm": "SHA256",
            "hash": digest,
            "blockSize": BLOCK,
            "blocks": blocks}


def resolve_node(root_files: dict, hpath: str):
    """hpath like '/dist/main.cjs' or '/node_modules/x/y/retry.js' -> (parent_dict, key, node)."""
    parts = [p for p in hpath.split('/') if p]
    if not parts:
        raise SystemExit(f'empty inject path: {hpath}')
    node = root_files  # files-dict (root of asar header "files")
    for p in parts[:-1]:
        if p not in node or 'files' not in node[p]:
            raise SystemExit(f'cannot find container {"/".join(parts[:-1])} for {hpath}')
        node = node[p]['files']
    if parts[-1] not in node:
        raise SystemExit(f'cannot find file {hpath}')
    return node, parts[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asar', required=True)
    ap.add_argument('--inject', action='append', required=True,
                    metavar='HDRPATH=SRCFILE', help='repeatable')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    injects = []
    for spec in a.inject:
        hpath, src = spec.split('=', 1)
        if not os.path.exists(src):
            sys.exit(f'inject source missing: {src}')
        injects.append((hpath, os.path.abspath(src)))

    with open(a.asar, 'rb') as f:
        _, header_len, _, str_len = struct.unpack('<IIII', f.read(16))
        f.seek(16)
        hdr = json.loads(f.read(str_len))
    old_base = 8 + header_len
    old_filesz = os.path.getsize(a.asar)
    total_data = old_filesz - old_base
    root = hdr['files']

    # resolve all injections against the OLD header first
    resolved = []
    for hpath, src in injects:
        parent, key = resolve_node(root, hpath)
        node = parent[key]
        if 'offset' not in node or 'size' not in node:
            sys.exit(f'{hpath} is a directory, not a file entry')
        data = open(src, 'rb').read()
        resolved.append({'path': hpath, 'parent': parent, 'key': key,
                         'old_off': int(node['offset']), 'old_size': int(node['size']),
                         'new_data': data})
    # sanity: no overlapping replaced regions
    resolved.sort(key=lambda r: r['old_off'])
    for i in range(1, len(resolved)):
        prev = resolved[i - 1]
        if resolved[i]['old_off'] < prev['old_off'] + prev['old_size']:
            sys.exit(f'overlapping inject regions: {prev["path"]} and {resolved[i]["path"]}')

    # per-file offset shift = cumulative delta of injections strictly before it
    def offset_shift(file_off: int) -> int:
        s = 0
        for r in resolved:
            if r['old_off'] < file_off:
                s += len(r['new_data']) - r['old_size']
            else:
                break
        return s

    # rewrite header
    def walk(files_dict):
        for k, v in files_dict.items():
            if 'offset' in v and 'size' in v:
                v['offset'] = str(int(v['offset']) + offset_shift(int(v['offset'])))
            if 'files' in v:
                walk(v['files'])
    walk(root)
    # apply replaced entries (fresh size/integrity at their NEW offset)
    for r in resolved:
        new_off = r['old_off'] + offset_shift(r['old_off'])
        r['new_off'] = new_off
        r['parent'][r['key']] = {"size": len(r['new_data']), "offset": str(new_off),
                                 "integrity": integrity_of(r['new_data'])}
        r['delta'] = len(r['new_data']) - r['old_size']

    total_delta = sum(r['delta'] for r in resolved)
    new_js = json.dumps(hdr, separators=(',', ':')).encode()
    new_header_len = 8 + len(new_js)
    new_header_len += (4 - (new_header_len % 4)) % 4
    new_base = 8 + new_header_len
    new_total = total_data + total_delta

    # stream-write data region
    src = open(a.asar, 'rb')
    with open(a.out, 'wb') as out:
        out.write(struct.pack('<IIII', 4, new_header_len, new_header_len - 4, len(new_js)))
        out.write(new_js)
        out.write(b'\0' * (new_header_len - 8 - len(new_js)))
        assert out.tell() == new_base == 8 + new_header_len
        cursor = 0
        for r in resolved:
            src.seek(old_base + cursor)
            out.write(src.read(r['old_off'] - cursor))
            out.write(r['new_data'])
            cursor = r['old_off'] + r['old_size']
        src.seek(old_base + cursor)
        out.write(src.read())
        out.truncate()
    src.close()
    print(f'wrote {a.out}: {os.path.getsize(a.out)} bytes (delta {total_delta:+d}); '
          f'header {header_len} -> {new_header_len}')
    for r in resolved:
        print(f'  {r["path"]}: off {r["old_off"]}->{r["new_off"]} size '
              f'{r["old_size"]}->{len(r["new_data"])}')


if __name__ == '__main__':
    main()
