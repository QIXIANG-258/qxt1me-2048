# -*- coding: utf-8 -*-
"""在 GitHub 建仓库（这台机器没有 gh CLI，走 API）。
token 从 Git Credential Manager 现取，只在本进程内存里过一遍，不落盘、不打印。

用法：
    python _tools/create_repo.py [--private]
"""
import io
import json
import subprocess
import sys
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

OWNER = "QIXIANG-258"
REPO = "qxt1me-2048"
DESC = "憩想站群的小游戏模块 —— 纯静态零依赖的 2048，零彩度原则首次为可用性让路"
TOPICS = ["2048", "game", "static-site", "cloudflare-workers", "vanilla-js"]


def get_token():
    """从 Git Credential Manager 取 token。不打印、不落盘。"""
    p = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True, encoding="utf-8",
    )
    for line in (p.stdout or "").splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    raise SystemExit("[x] 没取到凭据")


def call(method, url, token, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "token " + token)
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body[:400]}


def main():
    private = "--private" in sys.argv
    token = get_token()

    status, body = call("POST", "https://api.github.com/user/repos", token, {
        "name": REPO,
        "description": DESC,
        "private": private,
        "has_issues": True,
        "has_wiki": False,
        "has_projects": False,
        "auto_init": False,
    })
    if status == 201:
        print("[ok] 已建仓库 %s/%s" % (OWNER, REPO))
        print("     %s" % body.get("html_url"))
    elif status == 422:
        print("[i] 仓库已存在（422），继续设置 topics")
    else:
        print("[x] 建仓库失败 HTTP %s：%s" % (status, body))
        return 1

    status, body = call(
        "PUT",
        "https://api.github.com/repos/%s/%s/topics" % (OWNER, REPO),
        token,
        {"names": TOPICS},
    )
    print("[%s] topics HTTP %s" % ("ok" if status == 200 else "!", status))
    return 0


if __name__ == "__main__":
    sys.exit(main())
