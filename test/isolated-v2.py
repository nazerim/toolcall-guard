"""Exercise only the synthetic late-name stream, in a fresh private HOME."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[1]
root = Path(tempfile.mkdtemp(prefix="guard-v2-"))
cli = shutil.which("opencode")
node = shutil.which("node")
assert cli and node, "opencode and node must be on PATH"
env = {"PATH": os.pathsep.join([str(Path(cli).parent), str(Path(node).parent), os.defpath]), "HOME": str(root),
       "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_MODELS_FETCH": "1",
       "TOOLCALL_GUARD": "off", "SCENARIO": "late", "PORT": "0",
       "GUARDTEST_REQS": str(root / "requests"), "TOOLCALL_GUARD_V2_DEBUG": "stream"}
for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
            "XDG_RUNTIME_DIR", "TMPDIR"):
    (root / key).mkdir(mode=0o700)
    env[key] = str(root / key)
server = subprocess.Popen([shutil.which("node"), str(repo / "test/toolcall-guard-server.mjs")],
                          cwd=root, env=env, stdout=subprocess.PIPE, text=True)
try:
    port = int(server.stdout.readline().split()[3])
    cfg = json.loads((repo / "test/toolcall-guard-test.v2.opencode.json").read_text())
    cfg.update(plugins=[str(repo / "plugin-v2")], enabled_providers=["guardtest"], mcp={})
    cfg["provider"]["guardtest"]["options"]["baseURL"] = f"http://127.0.0.1:{port}/v1"
    (root / "opencode.json").write_text(json.dumps(cfg))
    version = subprocess.check_output([cli, "--version"], cwd=root, env=env, text=True).strip()
    assert version.removeprefix("opencode ").lstrip("v").startswith("2."), version
    run = subprocess.run([cli, "run", "--standalone", "--auto", "-m",
                          "guardtest/guardtest-model", "synthetic MARKER7788"],
                         cwd=root, env=env, capture_output=True, timeout=90)
    assert run.returncode == 0, f"isolated fixture exited {run.returncode}: {run.stderr[-1000:]!r}"
    requests = [json.loads(line) for line in (root / "requests").read_text().splitlines()]
    executed = any("GUARD_OK" in str(m.get("content")) for r in requests
                   for m in r["messages"] if m.get("role") == "tool")
    marker = root / "XDG_DATA_HOME/opencode/toolcall-guard.loaded"
    assert json.loads(marker.read_text())["providersWrapped"] == 1
    assert not marker.with_name("toolcall-guard.errors").exists()
    assert any(json.loads(l)["reason"] == "repaired" for l in
               marker.with_name("toolcall-guard.stream-info").read_text().splitlines())
    assert run.returncode == 0 and executed and b"ALL_DONE" in run.stdout + run.stderr
    print(version, "late-name tool result and final reply verified")
finally:
    server.terminate()
    server.wait()
    shutil.rmtree(root)
