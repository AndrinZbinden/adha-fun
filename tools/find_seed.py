#!/usr/bin/env python3
"""Brute-force PDA seed layouts for pump.fun fee-sharing config account."""

import base64
import hashlib
import json
import os
import struct
import sys
import urllib.request

# ── Crypto helpers (copied from check_split.py) ───────────────────────

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58_encode(b: bytes) -> str:
    if len(b) == 0:
        return ""
    n = int.from_bytes(b, "big")
    chars = []
    while n:
        n, r = divmod(n, 58)
        chars.append(ALPHABET[r])
    leading_zeros = 0
    for byte in b:
        if byte == 0:
            leading_zeros += 1
        else:
            break
    return ALPHABET[0] * leading_zeros + "".join(reversed(chars))


def base58_decode(s: str) -> bytes:
    n = 0
    for ch in s:
        n = n * 58 + ALPHABET.index(ch)
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    leading_zeros = 0
    for ch in s:
        if ch == "1":
            leading_zeros += 1
        else:
            break
    return b"\x00" * leading_zeros + b


def is_on_curve(pubkey: bytes) -> bool:
    if len(pubkey) != 32:
        return False
    p = 2**255 - 19
    d = (-121665 * pow(121666, p - 2, p)) % p
    sign = (pubkey[31] & 0x80) != 0
    y = int.from_bytes(pubkey[:31], "little") | ((pubkey[31] & 0x7F) << 248)
    if y >= p:
        return False
    y2 = (y * y) % p
    x2 = ((y2 - 1) * pow(d * y2 + 1, p - 2, p)) % p
    x = pow(x2, (p + 3) // 8, p)
    if (x * x - x2) % p != 0:
        x = (x * pow(2, (p - 1) // 4, p)) % p
    if (x * x - x2) % p != 0:
        return False
    if x == 0 and sign:
        return False
    return True


def find_program_address(seeds: list, program_id: bytes) -> tuple:
    for bump in range(255, -1, -1):
        parts = b"".join(seeds) + bytes([bump]) + program_id + b"ProgramDerivedAddress"
        digest = hashlib.sha256(parts).digest()
        if not is_on_curve(digest):
            return digest, bump
    raise ValueError("No valid PDA found")


def pubkey_to_base58(pubkey: bytes) -> str:
    return base58_encode(pubkey)


# ── Constants ──────────────────────────────────────────────────────────

ENV_PATH = "/data/workspace/.env"
RPC_ENV = "SOLANA_RPC_URL"

PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
MINT = "CjjgTZzvJaMSHnKedbjvyTogHMPRTXgu1H7VtHMNadha"
CREATOR = "FbH59fSNubUKPY1MzbGB78JBQZTok4DHjtxFCndN51R4"
CONFIG_ACCOUNT = "Dr5Dp6RqdN5gKXCnjbZ9Yqi52Gvdse5dihZm7pxE4VwG"

ADHA_EXECUTOR = "6xjNfNVyaigQYjLC7vNpUP4cbwHQNNdZhZpreemfvjjT"

SEED_STRINGS = [
    "fee_sharing_config",
    "fee-sharing-config",
    "feeSharingConfig",
    "fee_sharing",
    "fee_config",
    "sharing_config",
    "config",
    "fee_share_config",
    "fee_shares",
    "creator_vault",
    "fee_sharing_config_v2",
    "shared_fees",
    "fee_split",
    "revenue_share",
    "fee_sharing_account",
]

OUTPUT_REPORT = "/data/workspace/hooklaunch/tools/seed_report.txt"


# ── Load env ───────────────────────────────────────────────────────────

def load_env():
    if RPC_ENV in os.environ:
        return
    try:
        with open(ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                if key.strip() == RPC_ENV:
                    os.environ[RPC_ENV] = val.strip()
    except FileNotFoundError:
        pass


# ── RPC ────────────────────────────────────────────────────────────────

def rpc_call(method: str, params: list) -> dict:
    rpc_url = os.environ[RPC_ENV]
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(rpc_url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


# ── Main ───────────────────────────────────────────────────────────────

def main():
    load_env()
    if RPC_ENV not in os.environ:
        print("ERROR: SOLANA_RPC_URL not found", file=sys.stderr)
        sys.exit(1)

    program_id = base58_decode(PROGRAM_ID)
    mint_pubkey = base58_decode(MINT)
    creator_pubkey = base58_decode(CREATOR)
    target = base58_decode(CONFIG_ACCOUNT)
    adha_executor_pubkey = base58_decode(ADHA_EXECUTOR)

    # ── Task A: brute force seeds ─────────────────────────────────────
    matches = []

    for s in SEED_STRINGS:
        seed_bytes = s.encode("ascii")
        orderings = [
            ([seed_bytes, mint_pubkey], f"[{s}, mint]"),
            ([seed_bytes, creator_pubkey], f"[{s}, creator]"),
            ([mint_pubkey, seed_bytes], f"[mint, {s}]"),
            ([creator_pubkey, seed_bytes], f"[creator, {s}]"),
            ([seed_bytes, mint_pubkey, creator_pubkey], f"[{s}, mint, creator]"),
            ([seed_bytes, creator_pubkey, mint_pubkey], f"[{s}, creator, mint]"),
        ]
        for seeds, desc in orderings:
            try:
                pda, bump = find_program_address(seeds, program_id)
                if pda == target:
                    matches.append((s, desc, bump))
            except ValueError:
                pass

    # Orderings without any string seed
    no_string_orderings = [
        ([mint_pubkey], "[mint]"),
        ([creator_pubkey], "[creator]"),
        ([mint_pubkey, creator_pubkey], "[mint, creator]"),
        ([], "[]"),
    ]
    for seeds, desc in no_string_orderings:
        try:
            pda, bump = find_program_address(seeds, program_id)
            if pda == target:
                matches.append(("NONE", desc, bump) if seeds == [] else ("NONE", desc, bump))
        except ValueError:
            pass

    # ── Task B: read account ──────────────────────────────────────────
    resp = rpc_call("getAccountInfo", [CONFIG_ACCOUNT, {"encoding": "base64"}])
    value = resp.get("result", {}).get("value")
    if value is None:
        print("ERROR: account not found", file=sys.stderr)
        sys.exit(1)

    b64_data = value.get("data", [None])[0]
    raw = base64.b64decode(b64_data)

    # First 8 bytes as hex
    discriminator = raw[:8].hex()

    # Hexdump of first 160 bytes
    hexdump_lines = []
    for offset in range(0, min(160, len(raw)), 16):
        chunk = raw[offset:offset + 16]
        hex_part = " ".join(f"{b:02x}" for b in chunk)
        # Pad to consistent width
        hex_part = hex_part.ljust(47)
        ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        hexdump_lines.append(f"{offset:04x}:  {hex_part}  |{ascii_part}|")

    # Scan for known pubkeys
    known_addresses = {
        "creator": CREATOR,
        "mint": MINT,
        "adha_executor": ADHA_EXECUTOR,
    }
    pubkey_hits = {}
    for name, addr_str in known_addresses.items():
        addr_bytes = base58_decode(addr_str)
        for i in range(len(raw) - 31):
            if raw[i:i + 32] == addr_bytes:
                pubkey_hits[name] = i
                break
        if name not in pubkey_hits:
            pubkey_hits[name] = None

    # Scan for uint32 little-endian values between 1 and 16 in first 200 bytes
    count_candidates = []
    for offset in range(0, min(200, len(raw)) - 3):
        v = struct.unpack_from("<I", raw, offset)[0]
        if 1 <= v <= 16:
            count_candidates.append((offset, v))

    # Scan for uint16 little-endian values equal to 10000 or 5000 in whole buffer
    bps_candidates = []
    for offset in range(0, len(raw) - 1):
        v = struct.unpack_from("<H", raw, offset)[0]
        if v == 10000 or v == 5000:
            bps_candidates.append((offset, v))

    # ── Write report ──────────────────────────────────────────────────
    lines = []

    lines.append("SEED MATCHES")
    if matches:
        for seed_str, order, bump in matches:
            lines.append(f"MATCH seed_string={seed_str} order={order} bump={bump}")
    else:
        lines.append("MATCH NONE")
    lines.append("")

    lines.append("DISCRIMINATOR")
    lines.append(discriminator)
    lines.append("")

    lines.append("HEXDUMP")
    for hl in hexdump_lines:
        lines.append(hl)
    lines.append("")

    lines.append("PUBKEY HITS")
    for name in ["creator", "mint", "adha_executor"]:
        if pubkey_hits.get(name) is not None:
            lines.append(f"HIT {name} offset={pubkey_hits[name]}")
        else:
            lines.append(f"HIT {name} NONE")
    lines.append("")

    lines.append("COUNT CANDIDATES")
    if count_candidates:
        for offset, v in count_candidates:
            lines.append(f"U32 offset={offset} value={v}")
    else:
        lines.append("NONE")
    lines.append("")

    lines.append("BPS CANDIDATES")
    if bps_candidates:
        for offset, v in bps_candidates:
            lines.append(f"U16 offset={offset} value={v}")
    else:
        lines.append("NONE")

    report = "\n".join(lines)

    with open(OUTPUT_REPORT, "w") as f:
        f.write(report)

    print(report)


if __name__ == "__main__":
    main()
