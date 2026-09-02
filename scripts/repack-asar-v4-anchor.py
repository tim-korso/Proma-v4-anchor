#!/usr/bin/env python3
"""Repack Proma.app.asar injecting the fork-built main.cjs + agent-runtime.cjs (v4-anchor).

WHY (from issue #1956): the naive resize script only shifted files with
offset > block_end, but dist/preload.cjs sat exactly AT block_end, so its
offset was never shifted -> preload.cjs data was corrupted -> renderer white
screen ("Unable to load preload script" + window.api undefined).

The ONLY correct test is byte-identical preload + full app boot. This script:
  * keeps every non-replaced file at its original offset/size (incl. preload),
  * replaces agent-runtime.cjs + main.cjs in place (contiguous),
  * shifts ONLY files with offset >= block_end (fix: >=, not >),
  * regenerates header + SHA256 integrity blocks.

Usage:
  python3 scripts/repack-asar-v4-anchor.py \
      --asar app.asar --src-main dist/main.cjs --src-ar dist/agent-runtime.cjs \
      --out /tmp/app.asar.v4anchor.fixed

Verify (must ALL hold):
  1) @electron/asar list count identical to original
  2) extracted dist/preload.cjs md5 == original pre-image md5
  3) extracted dist/main.cjs == your fork dist/main.cjs (byte-identical)
  4) `grep -c 'v4AnchorMinThinkingTokens' <extracted main.cjs>` >= 2
  5) app boots + renderer DOM has children (no white screen)
"""
import argparse, hashlib, json, os, struct, sys

BLOCK = 4194304

def integrity_of(data: bytes) -> dict:
    blocks = [hashlib.sha256(data[i:i+BLOCK]).hexdigest()
              for i in range(0, len(data), BLOCK)]
    return {"algorithm": "SHA256",
            "hash": hashlib.sha256(''.join(blocks).encode()).hexdigest(),
            "blockSize": BLOCK,
            "blocks": blocks}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asar', required=True, help='original (clean) app.asar')
    ap.add_argument('--src-main', required=True, help='fork dist/main.cjs')
    ap.add_argument('--src-ar', required=True, help='fork dist/agent-runtime.cjs')
    ap.add_argument('--out', default='/tmp/app.asar.v4anchor.fixed')
    a = ap.parse_args()

    with open(a.asar, 'rb') as f:
        _, headerLen, _, strLen = struct.unpack('<IIII', f.read(16))
        f.seek(16)
        hdr = json.loads(f.read(strLen))
    filesz = os.path.getsize(a.asar)
    old_base = 8 + headerLen
    total_data = filesz - old_base

    ar = open(a.src_ar, 'rb').read()
    main = open(a.src_main, 'rb').read()
    if b'v4AnchorMinThinkingTokens' not in main:
        sys.exit('ERROR: src-main has no v4AnchorMinThinkingTokens; wrong build')

    dist = hdr['files']['dist']['files']
    old_ar, old_main = dist['agent-runtime.cjs'], dist['main.cjs']
    old_ar_off, old_main_off = int(old_ar['offset']), int(old_main['offset'])
    assert old_main_off == old_ar_off + int(old_ar['size']), 'ar/main not contiguous'
    block_end = old_main_off + int(old_main['size'])
    delta = (len(ar) + len(main)) - (int(old_ar['size']) + int(old_main['size']))

    dist['agent-runtime.cjs'] = {"size": len(ar), "offset": str(old_ar_off),
                                 "integrity": integrity_of(ar)}
    dist['main.cjs'] = {"size": len(main), "offset": str(old_ar_off + len(ar)),
                        "integrity": integrity_of(main)}

    def walk(node):
        if 'offset' in node and 'size' in node:
            o = int(node['offset'])
            if o >= block_end:                      # >= : the preload.cjs fix
                node['offset'] = str(o + delta)
        if 'files' in node:
            for v in node['files'].values():
                walk(v)
    walk(hdr)

    new_js = json.dumps(hdr, separators=(',', ':')).encode()
    new_header_len = 8 + len(new_js)
    new_header_len += (4 - (new_header_len % 4)) % 4
    new_base = 8 + new_header_len
    new_total = total_data + delta

    # Pre-checks (exactly what the white-screen bug depended on):
    #  - dist/preload.cjs must sit at offset >= block_end so it is shifted
    #  - dist/agent-runtime.cjs and dist/main.cjs must be contiguous
    dist = hdr['files']['dist']['files']
    for fname in ('preload.cjs', 'main.cjs', 'agent-runtime.cjs'):
        e = dist[fname]
        assert 'offset' in e and 'size' in e, f'no offset for {fname}'
    assert int(dist['preload.cjs']['offset']) >= block_end, \
        'preload.cjs is BEFORE block_end -> would corrupt; refusing'

    src = open(a.asar, 'rb')
    # NOTE: header offsets are RELATIVE to data base (8+headerLen). Absolute = old_base + offset.
    start_abs = old_base + old_ar_off          # absolute file pos of old agent-runtime data
    end_abs   = old_base + block_end           # absolute file pos: immediately after old main data
    src.seek(old_base)
    before = src.read(start_abs - old_base)    # unchanged slice before the ar/main block
    src.seek(end_abs)                          # tail must start at old block_end (relative), i.e. abs end_abs
    tail = src.read()                          # everything from there shifts by delta
    src.close()

    with open(a.out, 'wb') as f:
        f.write(struct.pack('<IIII', 4, new_header_len, new_header_len - 4, len(new_js)))
        f.write(new_js)
        f.write(b'\0' * (new_header_len - 8 - len(new_js)))
        assert f.tell() == new_base == 8 + new_header_len
        f.write(before)                        # unchanged slice before block
        f.write(ar)
        f.write(main)
        f.write(tail)
        f.truncate()
    print(f'wrote {a.out} ({os.path.getsize(a.out)} bytes, delta={delta})')

if __name__ == '__main__':
    main()
