"""Use a synthetic provider and private standalone CLI; never scan the host."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="guard-preflight-") as tmp:
    root = Path(tmp)
    env = {"HOME": tmp, "PATH": os.defpath + ":/opt/homebrew/bin",
           "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_MODELS_FETCH": "1",
           "TOOLCALL_GUARD_DATA_DIR": tmp, "PORT": "0", "SCENARIO": "late",
           "GUARDTEST_REQS": str(root / "requests")}
    for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
                "XDG_RUNTIME_DIR", "TMPDIR"):
        (root / key).mkdir(mode=0o700)
        env[key] = str(root / key)
    # Keep the existing fake-provider protocol; replace only its synthetic shell command.
    fixture = (repo / "test/toolcall-guard-server.mjs").read_text()
    assert fixture.count("ho GUARD_OK") == 1
    (root / "fixture.gguf").write_bytes(b"A\x00B")
    (root / "provider.mjs").write_text(fixture.replace("ho GUARD_OK", "ho start; find ./fixture.gguf; sleep 2; echo executed > sentinel; cat fixture.gguf"))
    server = subprocess.Popen([shutil.which("node"), "provider.mjs"], cwd=root, env=env,
                              stdout=subprocess.PIPE, text=True)
    try:
        port = int(server.stdout.readline().split()[3])
        cfg = json.loads((repo / "test/toolcall-guard-test.v2.opencode.json").read_text())
        cfg.update(plugins=[str(repo / "plugin-v2")], enabled_providers=["guardtest"], mcp={})
        cfg["provider"]["guardtest"]["options"]["baseURL"] = f"http://127.0.0.1:{port}/v1"
        (root / "opencode.json").write_text(json.dumps(cfg))
        for mode in ("log", "block", "binary", "clamp"):
            (root / "requests").write_text("")
            flags = ({"TOOLCALL_GUARD_CLAMP": "1", "TOOLCALL_GUARD_CLAMP_MS": "350"}
                     if mode == "clamp" else {"TOOLCALL_GUARD_BINARY":"1"}
                     if mode == "binary" else {"TOOLCALL_GUARD_PREFLIGHT": mode})
            run = subprocess.run([shutil.which("opencode"), "run", "--standalone", "--auto",
                                  "-m", "guardtest/guardtest-model", "synthetic MARKER7788"],
                                 cwd=root, env={**env, **flags},
                                 capture_output=True, timeout=90)
            assert run.returncode == 0 and b"ALL_DONE" in run.stdout + run.stderr
            sentinel = root / "sentinel"
            if mode != "clamp":
                assert sentinel.exists() == (mode in ("log", "binary")), mode
            sentinel.unlink(missing_ok=True)
            requests = [json.loads(x) for x in (root / "requests").read_text().splitlines()]
            def texts(part):
                if isinstance(part, str): yield part
                elif isinstance(part, dict):
                    for value in part.values(): yield from texts(value)
                elif isinstance(part, list):
                    for value in part: yield from texts(value)
            tool_text = "\n".join(s for r in requests for m in r["messages"] if m.get("role") == "tool"
                                  for s in texts(m.get("content")))
            if mode == "binary":
                assert "binary output suppressed" in tool_text and "\0" not in tool_text
                print(mode, "verified")
                continue
            if mode == "log":
                assert "A\0B" in tool_text
            records = [json.loads(x) for x in (root / "toolcall-guard.preflight").read_text().splitlines()]
            if mode == "clamp":
                assert records[-1]["kind"] == "clamp" and records[-1]["ms"] == 350
                assert any("background" in str(m.get("content")).lower() or "350 ms" in str(m.get("content"))
                           for r in requests for m in r["messages"] if m.get("role") == "tool")
            else:
                assert records[-1]["mode"] == mode and records[-1]["rule"] == "binary-peek"
            if mode == "block":
                assert any("refused shell call" in str(m.get("content")) for r in requests
                           for m in r["messages"] if m.get("role") == "tool")
            print(mode, "verified")
    finally:
        server.terminate()
        server.wait()
