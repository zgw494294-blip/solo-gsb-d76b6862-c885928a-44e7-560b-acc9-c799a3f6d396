"""单控制席后端回归测试（FastAPI TestClient + 独立临时数据库）。

覆盖：默认未启用旧调用不变；启用/接管凭 version 成功并落库（version +1）；
启用后全部写接口受保护（缺失/旧凭据 403 且数据不变）；旧席即使用最新
version 也不能写；同版本竞争最多一个成功；失败保留原控制席与版本；交接
不改提示、进度、暂停及档案；凭据与启用状态跨场保留；查询始终可用且永不
返回凭据。

运行：python3 tests/control-seat.test.py
"""
import os
import sys
import tempfile

_tmp = tempfile.mkdtemp(prefix="cue-control-test-")
os.environ["DB_PATH"] = os.path.join(_tmp, "cues.db")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from fastapi.testclient import TestClient  # noqa: E402

import app.main as main  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("  ✓ " + msg)
    else:
        failures += 1
        print("  ✗ " + msg)


def token_of(res):
    return res.json().get("control_token")


def no_token_leak(state):
    return "control_token" not in state


CUES2 = [{"number": "A1", "content": "灯光渐亮"}, {"number": "A2", "content": "音乐起"}]
CUES3 = CUES2 + [{"number": "A3", "content": "幕落"}]


def main_flow():
    with TestClient(main.app) as c:
        print("P1 默认未启用：旧调用不变，状态不含凭据")
        s = c.get("/api/state").json()
        check(s["control_enabled"] is False, "初始 control_enabled 为 false")
        check(no_token_leak(s), "状态查询不含 control_token 字段")
        v = s["version"]

        # 先建一个档案（供后续"以档案开新场"使用），全程无凭据 —— 旧调用不变
        r = c.post("/api/setup", json={"cues": CUES2})
        check(r.status_code == 200, "未启用时 setup 无凭据可用（旧调用不变）")
        v = r.json()["version"]
        r = c.post("/api/archive", json={"version": v, "name": "第一场"})
        check(r.status_code == 200, "未启用时 archive 无凭据可用")
        v = r.json()["version"]
        aid = c.get("/api/archives").json()["archives"][0]["id"]

        r = c.post("/api/setup", json={"cues": CUES3})
        check(r.status_code == 200, "未启用时再次 setup 无凭据可用")
        v = r.json()["version"]
        r = c.post("/api/confirm", json={"version": v})
        check(r.status_code == 200, "未启用时 confirm 无凭据可用")
        v = r.json()["version"]

        print("P2 启用控制席：凭 version，凭据仅成功时返回，version +1 一起落库")
        r = c.post("/api/control/takeover", json={"version": v})
        check(r.status_code == 409, "未启用时接管返回 409")
        check(r.json()["state"]["control_enabled"] is False, "409 附最新状态（仍未启用）")

        r = c.post("/api/control/enable", json={"version": v + 99})
        check(r.status_code == 409, "启用携带过期版本返回 409")
        s = c.get("/api/state").json()
        check(s["control_enabled"] is False and s["version"] == v, "失败保留原状态与版本")

        r = c.post("/api/control/enable", json={"version": v})
        check(r.status_code == 200, "凭当前 version 启用成功")
        tok1 = token_of(r)
        check(bool(tok1), "成功响应返回随机凭据 control_token")
        check(r.json()["control_enabled"] is True, "启用后 control_enabled 为 true")
        v = r.json()["version"]
        s = c.get("/api/state").json()
        check(s["version"] == v and s["control_enabled"] is True, "启用与 version +1 一起落库")
        check(no_token_leak(s), "状态查询仍不含凭据")

        r = c.post("/api/control/enable", json={"version": v})
        check(r.status_code == 409, "已启用时重复启用返回 409")

        print("P3 启用后：全部写接口受保护，缺失/错误凭据 403 且数据不变")
        before = c.get("/api/state").json()
        cue_id = before["pending"][0]["id"]
        order = [p["id"] for p in before["pending"]]
        writes = [
            ("POST", "/api/setup", {"cues": CUES2}),
            ("POST", "/api/confirm", {"version": v}),
            ("POST", "/api/pause", {"version": v, "paused": True}),
            ("POST", "/api/edit", {"version": v, "cue_id": cue_id, "content": "改写"}),
            ("POST", "/api/reorder", {"version": v, "order": order}),
            ("POST", "/api/issues", {"version": v, "cue_id": cue_id, "text": "问题"}),
            ("POST", "/api/archive", {"version": v, "name": "x"}),
            ("POST", "/api/reset", None),
            ("POST", f"/api/archives/{aid}/start", {"version": v}),
        ]
        for method, path, body in writes:
            r = c.post(path, json=body) if body is not None else c.post(path)
            check(r.status_code == 403, f"无凭据 {path} 返回 403")
            check("state" in r.json(), f"403 {path} 附最新状态")
        for method, path, body in writes:
            r = (c.post(path, json=body, headers={"X-Control-Token": "wrong"})
                 if body is not None else
                 c.post(path, headers={"X-Control-Token": "wrong"}))
            check(r.status_code == 403, f"错误凭据 {path} 返回 403")
        after = c.get("/api/state").json()
        check(after["version"] == v, "403 后版本号不变")
        check(after["pending"] == before["pending"] and after["issued"] == before["issued"],
              "403 后提示与进度不变")
        check(after["issues"] == before["issues"], "403 后问题记录不变")

        print("P4 正确凭据：写操作正常，version 逐步 +1")
        r = c.post("/api/pause", json={"version": v, "paused": True},
                   headers={"X-Control-Token": tok1})
        check(r.status_code == 200 and r.json()["paused"] is True, "凭据有效：暂停成功")
        v = r.json()["version"]
        r = c.post("/api/edit", json={"version": v, "cue_id": cue_id, "content": "灯光慢亮"},
                   headers={"X-Control-Token": tok1})
        check(r.status_code == 200, "凭据有效：编辑成功")
        v = r.json()["version"]
        r = c.post("/api/issues", json={"version": v, "cue_id": cue_id, "text": "音乐晚了 2 秒"},
                   headers={"X-Control-Token": tok1})
        check(r.status_code == 200 and len(r.json()["issues"]) == 1, "凭据有效：问题记录成功")
        v = r.json()["version"]
        r = c.post("/api/pause", json={"version": v, "paused": False},
                   headers={"X-Control-Token": tok1})
        check(r.status_code == 200 and r.json()["paused"] is False, "凭据有效：恢复成功")
        v = r.json()["version"]

        print("P5 接管：失败保留原控制席；成功后旧席凭最新 version 也不能写")
        r = c.post("/api/control/takeover", json={"version": v + 99})
        check(r.status_code == 409, "接管携带过期版本返回 409")
        r = c.post("/api/confirm", json={"version": v}, headers={"X-Control-Token": tok1})
        check(r.status_code == 200, "接管失败保留原控制席：旧凭据仍可用")
        v = r.json()["version"]

        snap = c.get("/api/state").json()
        archives_before = c.get("/api/archives").json()["archives"]
        r = c.post("/api/control/takeover", json={"version": v})
        check(r.status_code == 200, "凭当前 version 接管成功")
        tok2 = token_of(r)
        check(bool(tok2) and tok2 != tok1, "接管换发新随机凭据")
        v = r.json()["version"]
        now = c.get("/api/state").json()
        check(now["pending"] == snap["pending"] and now["issued"] == snap["issued"],
              "交接不改提示与进度")
        check(now["paused"] == snap["paused"], "交接不改暂停标记")
        check(now["issues"] == snap["issues"], "交接不改问题记录")
        check(c.get("/api/archives").json()["archives"] == archives_before, "交接不改档案")

        r = c.post("/api/confirm", json={"version": v}, headers={"X-Control-Token": tok1})
        check(r.status_code == 403, "旧席即使用最新 version 也被 403 拒绝")
        r = c.post("/api/confirm", json={"version": v})
        check(r.status_code == 403, "无凭据同样 403")
        check(c.get("/api/state").json()["version"] == v, "403 后数据不变")
        r = c.post("/api/confirm", json={"version": v}, headers={"X-Control-Token": tok2})
        check(r.status_code == 200, "新凭据可写")
        v = r.json()["version"]

        print("P6 同版本竞争：最多一个成功")
        r1 = c.post("/api/control/takeover", json={"version": v})
        r2 = c.post("/api/control/takeover", json={"version": v})
        codes = sorted([r1.status_code, r2.status_code])
        check(codes == [200, 409], "同版本两个接管：一个 200 一个 409")
        tok3 = token_of(r1) or token_of(r2)
        v = c.get("/api/state").json()["version"]
        r = c.post("/api/confirm", json={"version": v}, headers={"X-Control-Token": tok2})
        check(r.status_code == 403, "竞争失败后旧凭据失效")
        r = c.post("/api/issues", json={"version": v, "cue_id": cue_id, "text": "散场记录"},
                   headers={"X-Control-Token": tok3})
        check(r.status_code == 200, "竞争胜出凭据可写")
        v = r.json()["version"]

        print("P7 凭据与启用状态跨场保留（归档 / 重置 / 开新场均不清除）")
        r = c.post("/api/archive", json={"version": v, "name": "第二场"},
                   headers={"X-Control-Token": tok3})
        check(r.status_code == 200 and r.json()["status"] == "setup", "凭据有效：归档成功")
        v = r.json()["version"]
        check(r.json()["control_enabled"] is True, "归档后控制席仍启用")
        r = c.post("/api/setup", json={"cues": CUES2})
        check(r.status_code == 403, "跨场后无凭据仍 403")
        r = c.post("/api/setup", json={"cues": CUES2}, headers={"X-Control-Token": tok3})
        check(r.status_code == 200, "跨场后原凭据仍有效")
        v = r.json()["version"]
        r = c.post("/api/reset", headers={"X-Control-Token": tok3})
        check(r.status_code == 200 and r.json()["control_enabled"] is True,
              "重置后控制席仍启用")
        v = r.json()["version"]
        r = c.post(f"/api/archives/{aid}/start", json={"version": v})
        check(r.status_code == 403, "以档案开新场无凭据 403")
        r = c.post(f"/api/archives/{aid}/start", json={"version": v},
                   headers={"X-Control-Token": tok3})
        check(r.status_code == 200 and r.json()["status"] == "live", "以档案开新场凭据有效")
        v = r.json()["version"]

        print("P8 查询始终可用（无凭据）")
        check(c.get("/api/state").status_code == 200, "GET /api/state 无凭据可用")
        check(c.get("/api/archives").status_code == 200, "GET /api/archives 无凭据可用")
        check(c.get(f"/api/archives/{aid}").status_code == 200, "GET 档案详情无凭据可用")
        check(c.get(f"/api/compare?base={aid}&compare={aid}").status_code == 200,
              "GET /api/compare 无凭据可用")

        print("P9 暂停标记跨交接保留；接管使旧 version 业务写过期")
        r = c.post("/api/pause", json={"version": v, "paused": True},
                   headers={"X-Control-Token": tok3})
        check(r.status_code == 200 and r.json()["paused"] is True, "暂停成功")
        v = r.json()["version"]
        r = c.post("/api/control/takeover", json={"version": v})
        check(r.status_code == 200, "暂停中可接管")
        tok4 = token_of(r)
        check(r.json()["paused"] is True, "交接不改暂停标记")
        r = c.post("/api/pause", json={"version": v, "paused": False},
                   headers={"X-Control-Token": tok4})
        check(r.status_code == 409, "接管后旧 version 的业务写返回 409")
        v = r.json()["state"]["version"]
        r = c.post("/api/pause", json={"version": v, "paused": False},
                   headers={"X-Control-Token": tok4})
        check(r.status_code == 200 and r.json()["paused"] is False, "新凭据 + 新 version 可写")


def enable_competition():
    """全新库：同版本启用竞争最多一个成功；启用后旧 version 接管过期。"""
    main.DB_PATH = os.path.join(_tmp, "cues2.db")
    with TestClient(main.app) as c:
        print("P10 同版本启用竞争（全新库）")
        r1 = c.post("/api/control/enable", json={"version": 0})
        r2 = c.post("/api/control/enable", json={"version": 0})
        check(sorted([r1.status_code, r2.status_code]) == [200, 409],
              "同版本两个启用：一个 200 一个 409")
        r = c.post("/api/control/takeover", json={"version": 0})
        check(r.status_code == 409, "启用成功后旧 version 接管返回 409")


main_flow()
enable_competition()

print("\n全部通过" if failures == 0 else f"\n失败 {failures} 处断言")
sys.exit(0 if failures == 0 else 1)
