#!/usr/bin/env python3
"""Check pump.fun fee-sharing config accounts for each Adha.fun launch."""

import base64
import hashlib
import json
import os
import struct
import sys
import urllib.request
import urllib.error

# ── Paths ──────────────────────────────────────────────────────────────
ENV_PATH = "/data/workspace/.env"
RPC_ENV = "SOLANA_RPC_URL"
LAUNCHES_URL = "https://adha.fun/api/launches"
FEE_SHARING_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
OUTPUT_REPORT = "/data/workspace/hooklaunch/tools/check_split_report.txt"

# ── Helpers ────────────────────────────────────────────────────────────

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58_encode(b: bytes) -> str:
    """Pure-Python base58 encode."""
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
    """Pure-Python base58 decode."""
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
    """Check if a 32-byte ed25519 public key is on the curve."""
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
    """Find PDA (address, bump) for given seeds and program id."""
    for bump in range(255, -1, -1):
        parts = b"".join(seeds) + bytes([bump]) + program_id + b"ProgramDerivedAddress"
        digest = hashlib.sha256(parts).digest()
        if not is_on_curve(digest):
            return digest, bump
    raise ValueError("No valid PDA found")


def pubkey_to_base58(pubkey: bytes) -> str:
    return base58_encode(pubkey)


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


# ── Parse config account data ──────────────────────────────────────────

def parse_config(raw: bytes):
    """Parse fee_sharing_config account data. Returns (admin_revoked, shareholders)."""
    # Layout: 8(disc) + 1 + 1 + 1 + 32(launch) + 32(admin) = offset 75
    offset = 8 + 1 + 1 + 1 + 32 + 32
    admin_revoked = raw[offset] == 1
    offset += 1
    n = struct.unpack_from("<I", raw, offset)[0]
    offset += 4
    shareholders = []
    for _ in range(n):
        addr = base58_encode(raw[offset:offset + 32])
        share_bps = struct.unpack_from("<H", raw, offset + 32)[0]
        shareholders.append((addr, share_bps))
        offset += 34
    return admin_revoked, shareholders


# ── Main ───────────────────────────────────────────────────────────────

def main():
    load_env()
    if RPC_ENV not in os.environ:
        print("ERROR: SOLANA_RPC_URL not found", file=sys.stderr)
        sys.exit(1)

    program_id = base58_decode(FEE_SHARING_PROGRAM)

    # Fetch launches
    req = urllib.request.Request(LAUNCHES_URL, headers={"User-Agent": "check_split/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    launches = data.get("launches", [])

    lines = []
    exists_count = 0
    missing_count = 0

    for launch in launches:
        mint_str = launch.get("mint", "")
        name = launch.get("name", "")
        hook_id = launch.get("hookId", "")
        policy_sig = launch.get("policySig")

        mint_pubkey = base58_decode(mint_str)
        pda, bump = find_program_address(
            [b"fee_sharing_config", mint_pubkey], program_id
        )
        pda_b58 = pubkey_to_base58(pda)

        db_policy = "yes" if policy_sig else "no"

        # RPC query
        resp = rpc_call("getAccountInfo", [pda_b58, {"encoding": "base64"}])
        value = resp.get("result", {}).get("value")

        if value is None:
            config_status = "MISSING"
            revoked_str = "n/a"
            shareholders_str = "n/a"
            shareholder_lines = []
            missing_count += 1
        else:
            config_status = "EXISTS"
            exists_count += 1
            b64_data = value.get("data", [None])[0]
            raw = base64.b64decode(b64_data)
            admin_revoked, shareholders = parse_config(raw)
            revoked_str = "yes" if admin_revoked else "no"
            shareholders_str = str(len(shareholders))
            shareholder_lines = [f"  {addr} {share_bps}" for addr, share_bps in shareholders]

        lines.append(f"MINT {mint_str}")
        lines.append(f"NAME {name} | HOOK {hook_id} | DB_POLICYSIG {db_policy}")
        lines.append(f"PDA {pda_b58}")
        lines.append(f"CONFIG {config_status}")
        lines.append(f"REVOKED {revoked_str}")
        lines.append(f"SHAREHOLDERS {shareholders_str}")
        lines.extend(shareholder_lines)
        lines.append("")  # blank line between blocks

    total = exists_count + missing_count
    lines.append(f"SUMMARY exists={exists_count} missing={missing_count} total={total}")

    report = "\n".join(lines)

    # Write report
    with open(OUTPUT_REPORT, "w") as f:
        f.write(report)

    # Print to stdout
    print(report)


if __name__ == "__main__":
    main()
