# -*- coding: utf-8 -*-
"""自签 HTTPS 端到端验证:启动真实服务 → 用 CA 校验握手 → 指纹/重定向/仅HTTPS。

用法: bundle314/Scripts/python.exe _diag/tls_live_test.py
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
HTTP_PORT = 8911
HTTPS_PORT = HTTP_PORT + 1
DATA = os.path.join(ROOT, "_diag", "_tlsdata")


def wait_port(port: int, host: str = "127.0.0.1", timeout: float = 25.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection((host, port), timeout=0.6):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def main() -> int:
    shutil.rmtree(DATA, ignore_errors=True)
    os.makedirs(DATA, exist_ok=True)
    cfg = {
        "sources": [],
        "settings": {
            "lan_access": True,
            "https_enabled": True,
            "https_only": False,
            "verify_ssl": True,
        },
    }
    with open(os.path.join(DATA, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f)

    env = dict(os.environ, NOVEL_DATA_DIR=DATA, PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "gui_server.py", "--port", str(HTTP_PORT)],
        cwd=ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
    )
    results: list[tuple[str, bool, str]] = []
    try:
        if not wait_port(HTTP_PORT):
            out = proc.stdout.read() if proc.stdout else ""
            print("启动失败:\n", out)
            return 1
        wait_port(HTTPS_PORT)

        ca_path = os.path.join(DATA, "tls", "ca.crt")
        results.append(("CA 证书已生成", os.path.isfile(ca_path), ca_path))
        ctx = ssl.create_default_context(cafile=ca_path)

        # 1. HTTPS 请求应成功且证书链可信
        try:
            with urllib.request.urlopen(f"https://127.0.0.1:{HTTPS_PORT}/api/ping",
                                        context=ctx, timeout=8) as r:
                body = json.loads(r.read().decode())
            results.append(("HTTPS + CA 校验通过", r.status == 200, f"status={r.status} keys={sorted(body)[:4]}"))
        except Exception as exc:  # noqa: BLE001
            results.append(("HTTPS + CA 校验通过", False, f"{type(exc).__name__}: {exc}"))

        # 2. 用默认信任库(不含本机 CA)必须失败 —— 证明不是「无条件放行」
        try:
            with urllib.request.urlopen(f"https://127.0.0.1:{HTTPS_PORT}/api/ping", timeout=8) as r:
                _ = r.read()
            results.append(("未装 CA 时被拒绝", False, "竟然通过了(证书未被校验)"))
        except ssl.SSLError as exc:
            results.append(("未装 CA 时被拒绝", True, type(exc).__name__))
        except urllib.error.URLError as exc:
            results.append(("未装 CA 时被拒绝", True, f"URLError/{type(exc.reason).__name__}"))

        # 3. 直连端口 8911 走明文仍可用(本机回环不受 https_only 影响)
        with urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}/api/ping", timeout=8) as r:
            results.append(("本机明文 HTTP 仍可用", r.status == 200, f"status={r.status}"))

        # 4. /api/tls 报告状态与指纹
        with urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}/api/tls", timeout=8) as r:
            tlsinfo = json.loads(r.read().decode())
        fp = tlsinfo.get("fingerprint") or ""
        results.append(("指纹为 64 位十六进制对", fp.count(":") == 31 and len(fp) == 95, fp[:29] + "…"))
        results.append(("listening 为真", bool(tlsinfo.get("listening")), f"scheme={tlsinfo.get('scheme')} port={tlsinfo.get('port')}"))
        results.append(("CA 可下载", urllib.request.urlopen(
            f"http://127.0.0.1:{HTTP_PORT}/tls/ca.crt", timeout=8).status == 200, "/tls/ca.crt"))

        # 5. 打开 https_only → 局域网来源走明文应被 301(本机回环除外)
        from novel import netinfo  # noqa: E402
        lan_ip = netinfo.best_ip() or ""
        req = urllib.request.Request(f"http://127.0.0.1:{HTTP_PORT}/api/tls",
                                     data=json.dumps({"enabled": True, "only": True}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=8) as r:
            tog = json.loads(r.read().decode())
        results.append(("热切换 only=True 生效", tog.get("ok") and tog.get("only") and tog.get("listening"),
                        f"restart_required={tog.get('restart_required')}"))

        if lan_ip:
            class NoRedir(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *a, **k):
                    return None
            opener = urllib.request.build_opener(NoRedir)
            try:
                with opener.open(f"http://{lan_ip}:{HTTP_PORT}/api/ping", timeout=8) as r:
                    results.append(("局域网明文被转 301", False, f"status={r.status} 未被拦截"))
            except urllib.error.HTTPError as exc:
                loc = exc.headers.get("Location") or ""
                ok = exc.code == 301 and loc.startswith(f"https://{lan_ip}:{HTTPS_PORT}")
                results.append(("局域网明文被转 301", ok, f"{exc.code} → {loc}"))
            except Exception as exc:  # noqa: BLE001
                results.append(("局域网明文被转 301", False, f"{type(exc).__name__}: {exc}"))

            # 6. 同一地址的 HTTPS 加密通道必须能连
            ctx2 = ssl.create_default_context(cafile=ca_path)
            try:
                with urllib.request.urlopen(f"https://{lan_ip}:{HTTPS_PORT}/api/ping",
                                            context=ctx2, timeout=8) as r:
                    results.append(("局域网 IP 的 HTTPS 可用", r.status == 200, f"{lan_ip} status={r.status}"))
            except Exception as exc:  # noqa: BLE001
                results.append(("局域网 IP 的 HTTPS 可用", False, f"{type(exc).__name__}: {exc}"))

            # 7. 手机端配对二维码地址应带上 https 与 alt 候选
            with urllib.request.urlopen(urllib.request.Request(
                    f"http://127.0.0.1:{HTTP_PORT}/api/mobile/pair/start", data=b"{}",
                    headers={"Content-Type": "application/json"}, method="POST"), timeout=10) as r:
                pair = json.loads(r.read().decode())
            uri = str(pair.get("uri") or "")
            results.append(("配对码用 https", pair.get("base_url", "").startswith(f"https://"), pair.get("base_url")))
            results.append(("配对码带候选地址", "alt=" in uri, f"candidates={pair.get('candidates')}"))
            results.append(("配对码带 CA 指纹 pin", "&pin=" in uri and len(pair.get("pin") or "") >= 20,
                            f"pin={pair.get('pin')}"))

            # 8. 体检应按加密口径报告,且证书覆盖检查通过
            with urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}/api/doctor", timeout=20) as r:
                doc = json.loads(r.read().decode())
            checks = {c["key"]: c for c in doc.get("checks") or []}
            results.append(("体检用 https 口径", doc.get("scheme") == "https",
                            f"port={doc.get('port')} secure={doc.get('secure')}"))
            results.append(("证书覆盖检查通过", checks.get("tls_cert", {}).get("status") == "ok",
                            checks.get("tls_cert", {}).get("detail", "")))
            nics = [c for c in doc.get("checks") or [] if c["key"].startswith("nic:")]
            results.append(("各网卡 TLS 自连全部通过",
                            bool(nics) and all(c["status"] == "ok" for c in nics),
                            f"{sum(1 for c in nics if c['status'] == 'ok')}/{len(nics)}"))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()

    print("\n===== 自签 HTTPS 端到端验证 =====")
    bad = 0
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:24s} {detail}")
        bad += 0 if ok else 1
    print(f"\n{len(results) - bad}/{len(results)} 通过")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
