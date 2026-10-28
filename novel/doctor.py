# -*- coding: utf-8 -*-
"""手机连接体检 —— 一次把「为什么连不上」拆到具体环节。

排查顺序按链路从内到外,任何一环失败都会让手机连不进来:

    局域网开关 → 服务器绑定地址 → 回环自连 → 每张网卡自连 → 防火墙入站 → sshd(仅加密通道用)

设计取舍:
    - 「自连」用 socket.connect 实测,比读配置可靠:绑定没覆盖到的地址会直接超时。
    - 防火墙不用 COM(INetFwPolicy2 太重),用 PowerShell 查一次入站允许规则;
      查不到不算致命,只给 warn + 放行命令,避免误判把用户带偏。
    - sshd 只作为「加密通道」能力报告,不影响手机直连是否可用的结论。
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys

from . import netinfo

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _self_connect(host: str, port: int, timeout: float = 0.8) -> str:
    """从本机连指定地址,返回空串表示通,否则返回错误摘要。"""
    if not host or not port:
        return "地址或端口缺失"
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return ""
    except socket.timeout:
        return "连接超时"
    except OSError as exc:
        return str(exc)[:80]


def _tls_self_connect(host: str, port: int, timeout: float = 1.5) -> str:
    """TLS 自连:连上之后还要真的握手成功,才算手机能连。

    只测 TCP 是不够的 —— 端口开着但证书 SAN 不含这个 IP 时,手机侧就是
    「证书不匹配」,表现和连不上几乎一样,必须在这里就分辨出来。
    """
    if not host or not port:
        return "地址或端口缺失"
    import ssl as _ssl

    from . import tls as _tls
    try:
        ctx = _ssl.create_default_context(cafile=_tls.CA_CERT)
    except (OSError, _ssl.SSLError):
        return "本机 CA 证书缺失,请重新生成"
    sock = None
    try:
        sock = socket.create_connection((host, int(port)), timeout=timeout)
        with ctx.wrap_socket(sock, server_hostname=host) as ssock:
            ssock.do_handshake()
        return ""
    except socket.timeout:
        return "连接超时"
    except _ssl.SSLCertVerificationError as exc:
        # 证书里没有这个地址 → 手机也会报同样的错
        return f"证书不匹配({exc.verify_message or 'SAN 未覆盖该地址'})"
    except _ssl.SSLError as exc:
        return f"TLS 握手失败({str(exc)[:60]})"
    except OSError as exc:
        return str(exc)[:80]
    finally:
        try:
            if sock is not None:
                sock.close()
        except OSError:
            pass


def _run(args: list[str], timeout: float = 3.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                              creationflags=CREATE_NO_WINDOW,
                              encoding="utf-8", errors="replace")
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # noqa: BLE001
        return -1, str(exc)[:120]


_FW_KEY = (r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters"
           r"\FirewallPolicy\FirewallRules")


def firewall_rule(program_hint: str = "novel") -> dict:
    """从注册表读入站放行规则(免提权、免子进程、不受系统语言影响)。

    规则值形如:
        v2.10|Action=Allow|Active=TRUE|Dir=In|Protocol=6|Profile=Public|App=C:\\...\\x.exe|...
    只认 Dir=In + Action=Allow + Active=TRUE,并匹配当前程序路径或程序名。
    """
    if os.name != "nt":
        return {"known": False, "allow": False, "detail": "非 Windows,跳过防火墙检查", "profiles": []}
    try:
        import winreg
        key_path = _FW_KEY
        exe = os.path.basename(sys.executable or "").lower()
        matched_profiles: set[str] = set()
        matched_apps: list[str] = []
        exact_hit = False
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as key:
            total = winreg.QueryInfoKey(key)[1]
            for i in range(total):
                try:
                    _, value, _ = winreg.EnumValue(key, i)
                except OSError:
                    continue
                text = str(value)
                if "Dir=In" not in text or "Action=Allow" not in text or "Active=TRUE" not in text:
                    continue
                low = text.lower()
                if program_hint not in low:
                    continue
                # 开发版/安装版可能并存:优先认「正好是本进程」的规则
                if exe and exe in low:
                    exact_hit = True
                for part in text.split("|"):
                    if part.startswith("Profile="):
                        matched_profiles.update(p.strip() for p in part[8:].split(",") if p.strip())
                    elif part.startswith("App="):
                        matched_apps.append(os.path.basename(part[4:].strip()))
    except OSError as exc:
        return {"known": False, "allow": False, "detail": f"读取防火墙规则失败: {exc}", "profiles": []}
    except Exception as exc:  # noqa: BLE001
        return {"known": False, "allow": False, "detail": f"读取防火墙规则失败: {exc}", "profiles": []}

    allow = bool(matched_apps)
    profiles = sorted(p for p in matched_profiles if p)
    if allow:
        names = ", ".join(sorted(set(matched_apps))[:3])
        detail = f"已放行 {names}" + (f"(配置档 {'/'.join(profiles)})" if profiles else "")
        if not exact_hit:
            detail += ";未匹配到当前可执行文件,若仍连不上请重新放行"
    else:
        detail = "没有找到本程序的入站放行规则"
    return {"known": True, "allow": allow, "detail": detail,
            "profiles": profiles, "exact": exact_hit}


def sshd_status() -> dict:
    """Windows OpenSSH 服务端状态 + 端口 + 是否已有公钥。"""
    info = {
        "platform": "windows" if os.name == "nt" else sys.platform,
        "running": False,
        "port": 22,
        "listening": False,
        "password_auth": None,
        "authorized_keys": False,
        "detail": "",
    }
    if os.name == "nt":
        code, out = _run(["sc", "query", "sshd"])
        # sc 输出是本地化的,但 STATE 值 4 RUNNING 的单词保持英文
        info["running"] = "RUNNING" in (out or "").upper()
        if not info["running"]:
            info["detail"] = "未检测到运行中的 sshd 服务"
        config = os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"),
                              "ssh", "sshd_config")
        try:
            with open(config, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            for line in text.splitlines():
                low = line.strip().lower()
                if low.startswith("port "):
                    try:
                        info["port"] = int(low.split()[1])
                    except (IndexError, ValueError):
                        pass
                elif low.startswith("passwordauthentication"):
                    info["password_auth"] = low.split()[-1].lower() != "no"
        except OSError:
            pass
    else:
        code, out = _run(["sh", "-c", "pgrep -x sshd | head -1"])
        info["running"] = code == 0 and bool((out or "").strip())

    info["listening"] = not _self_connect("127.0.0.1", info["port"], 0.6)

    home = os.path.expanduser("~")
    for path in (
        os.path.join(home, ".ssh", "authorized_keys"),
        os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "ssh",
                     "administrators_authorized_keys"),
    ):
        try:
            if os.path.getsize(path) > 0:
                info["authorized_keys"] = True
                break
        except OSError:
            continue
    return info


def ssh_command(port: int, host: str, user: str = "") -> str:
    """手机侧要执行的一行命令:把电脑的 HTTP 端口经 SSH 加密转发到本地回环。"""
    target = f"{user}@{host}" if user else host
    return f"ssh -N -L {port}:127.0.0.1:{port} {target}"


def diagnose(port: int, lan_access: bool, bind_host: str = "",
             scheme: str = "http", https_only: bool = False) -> dict:
    """组装体检结果。checks 里 status: ok / warn / fail。

    scheme="https" 时按加密端口(port+1)实测握手,并额外体检证书本身
    (是否存在 / SAN 是否覆盖当前网卡 / 是否快过期)。
    """
    port = int(port or 0)
    secure = str(scheme or "http").lower() == "https"
    probe = (lambda host, p: _tls_self_connect(host, p, max(1.5, 0.8)) if secure
             else _self_connect(host, p))
    checks: list[dict] = []
    adapters = netinfo.adapters(force=True)
    candidates = netinfo.candidates(port, scheme="https" if secure else "http", force=True)

    checks.append({
        "key": "lan_access",
        "label": "局域网访问开关",
        "status": "ok" if lan_access else "fail",
        "detail": "已开启,服务器允许局域网设备接入" if lan_access
                  else "已关闭,服务器只监听 127.0.0.1,手机无法连入",
        "hint": "" if lan_access else "打开「局域网访问」开关后重启应用",
    })

    wildcard = bind_host in ("0.0.0.0", "::", "")
    checks.append({
        "key": "bind",
        "label": "服务器绑定地址",
        "status": "ok" if wildcard else "fail",
        "detail": f"当前监听 {bind_host or '未知'}:{port}" + ("(全部网卡)" if wildcard else "(仅本机)"),
        "hint": "" if wildcard else "关闭再开启一次局域网访问,让进程以 0.0.0.0 重新绑定",
    })

    # ---- 证书体检(仅 HTTPS)----
    if secure:
        from . import tls as _tls
        st = _tls.status([a["ip"] for a in adapters])
        covered = set(st.get("hosts") or [])
        missing = [a["ip"] for a in adapters if a["ip"] not in covered]
        if not st.get("cert_exists"):
            tls_status, detail = "fail", "证书还没生成"
            hint = "在设置页重新开启一次 HTTPS,程序会按当前网卡签发证书"
        elif missing:
            tls_status = "fail"
            detail = f"证书未覆盖当前网卡: {', '.join(missing[:3])}"
            hint = "手机连这些地址会报「证书不匹配」;关闭再开启 HTTPS 即可按新地址重签(CA 不变,手机不用重装)"
        else:
            tls_status, hint = "ok", ""
            detail = f"已覆盖 {len(covered)} 个地址,指纹 {st.get('fingerprint', '')[:17]}…"
        checks.append({
            "key": "tls_cert",
            "label": "自签证书覆盖范围",
            "status": tls_status,
            "detail": detail,
            "hint": hint,
        })

    loop_err = probe("127.0.0.1", port)
    checks.append({
        "key": "loopback",
        "label": "本机回环连通",
        "status": "ok" if not loop_err else "fail",
        "detail": f"127.0.0.1:{port} 可连接" if not loop_err else f"127.0.0.1:{port} {loop_err}",
        "hint": "" if not loop_err else "服务未真正启动,或端口被占用",
    })

    for item in candidates:
        err = probe(item["ip"], port)
        checks.append({
            "key": f"nic:{item['ip']}",
            "label": f"{item['label']} {item['ip']}",
            "status": "ok" if not err else "fail",
            "detail": f"{item['url']} 可连接" if not err else f"{item['url']} {err}",
            "hint": "" if not err else "该网卡未绑定(检查局域网开关)或被防火墙拦截",
            "recommended": bool(item.get("recommended")),
        })

    nic_failed = any(c["status"] == "fail" for c in checks if c["key"].startswith("nic:"))
    fw = firewall_rule()
    if fw["known"] and fw["allow"]:
        fw_status, fw_hint = "ok", ""
    elif fw["known"]:
        fw_status = "warn" if nic_failed else "ok"
        fw_hint = ("若手机仍连不上,可能是防火墙拦截。以管理员身份执行:\n"
                   f"netsh advfirewall firewall add rule name=\"NovelCrawler\" "
                   f"dir=in action=allow program=\"<程序路径>\" enable=yes profile=any")
    else:
        fw_status, fw_hint = "warn", "无法确认防火墙状态;若手机连不上,先用上面的命令放行"
    checks.append({
        "key": "firewall",
        "label": "防火墙入站规则",
        "status": fw_status,
        "detail": fw["detail"],
        "hint": fw_hint,
    })

    ssh = sshd_status()
    checks.append({
        "key": "sshd",
        "label": "SSH 服务端(加密通道用)",
        "status": "ok" if ssh["running"] and ssh["listening"] else "warn",
        "detail": (f"运行中,监听 {ssh['port']}" if ssh["running"] and ssh["listening"]
                   else ("服务在跑但端口未监听" if ssh["running"] else "未运行")),
        "hint": "" if ssh["running"] and ssh["listening"] else "仅在需要加密转发时才要求",
    })

    ok = not any(c["status"] == "fail" for c in checks)
    primary = candidates[0]["ip"] if candidates else netinfo.best_ip()
    return {
        "ok": ok,
        "port": port,
        "lan_access": lan_access,
        "bind_host": bind_host,
        "scheme": "https" if secure else "http",
        "secure": secure,
        "https_only": bool(https_only),
        "checks": checks,
        "candidates": candidates,
        "ssh": ssh,
        "ssh_command": ssh_command(port, primary, os.environ.get("USERNAME") or os.environ.get("USER") or ""),
        "ssh_host": primary,
    }


if __name__ == "__main__":  # 自测:python -m novel.doctor 8899 [https]
    import json
    p = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    sch = sys.argv[2] if len(sys.argv) > 2 else "http"
    print(json.dumps(diagnose(p, False, "127.0.0.1", sch), ensure_ascii=False, indent=2))


def allow_firewall(port: int = 0) -> dict:
    """为当前程序加一条「所有网络配置」的入站放行规则。

    热点网卡常被 Windows 归为「公用网络」,只放行"专用"的规则对它无效,
    所以这里显式 profile=any。需要管理员权限:netsh 会返回 5(拒绝访问),
    此时给出 needs_admin=True,由前端提示"以管理员身份重试"。
    """
    import subprocess
    if os.name != "nt":
        return {"ok": False, "needs_admin": False, "error": "仅支持 Windows"}
    exe = sys.executable or ""
    if not exe:
        return {"ok": False, "needs_admin": False, "error": "取不到程序路径"}
    cmd = [
        "netsh", "advfirewall", "firewall", "add", "rule",
        "name=NovelCrawler", "dir=in", "action=allow",
        f"program={exe}", "enable=yes", "profile=any",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=15, creationflags=0x08000000)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "needs_admin": False, "error": f"执行失败: {exc}"}
    if proc.returncode == 0:
        # 再加一条「按端口」的规则:程序规则依赖 exe 路径(dev/安装版/更新后路径会变),
        # 端口规则对所有进程生效,是更可靠的一层保险。
        if port:
            try:
                subprocess.run([
                    "netsh", "advfirewall", "firewall", "add", "rule",
                    f"name=NovelCrawler-{port}", "dir=in", "action=allow",
                    "protocol=TCP", f"localport={port}", "profile=any",
                ], capture_output=True, text=True, timeout=15, creationflags=0x08000000)
            except (OSError, subprocess.SubprocessError):
                pass
        return {"ok": True, "needs_admin": False,
                "detail": f"已放行(程序 + 端口 {port})" if port else "已放行(专用+公用网络)"}
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 5 or "需要提升" in out or "requires elevation" in out.lower():
        return {"ok": False, "needs_admin": True,
                "error": "需要管理员权限:请以管理员身份重启本程序后再点一次"}
    return {"ok": False, "needs_admin": False, "error": out.strip()[:200] or "未知错误"}
