import assert from "node:assert/strict"
import plugin from "../plugins/toolcall-guard.js"

const { preflightPattern, SCANLIKE } = plugin.__test

// zero-ambiguity unbounded patterns fire
assert.equal(preflightPattern("grep -rn 'secret' /"), "recursive-grep-root")
assert.equal(preflightPattern("grep -rln foo ~/ "), "recursive-grep-root")
assert.equal(preflightPattern("find / -name '*.gguf'"), "find-root")
assert.equal(preflightPattern("find ~ -name 'token*'"), "find-root")
assert.equal(preflightPattern("rm -rf ~/"), "rm-rf-unbounded")
assert.equal(preflightPattern("ls -R / | head"), "ls-R-root")
assert.equal(preflightPattern("du -sh $HOME"), "du-root")

// scoped/bounded commands never fire (the zero-FP requirement)
assert.equal(preflightPattern("grep -rn 'pattern' ./src --include='*.ts'"), null)
assert.equal(preflightPattern("grep -rn TODO /Users/naz/Projects/Scratch/jev-local | head"), null)
assert.equal(preflightPattern("find ./models -maxdepth 2 -name '*.gguf'"), null)
assert.equal(preflightPattern("npm test 2>&1 | tail -40"), null)
assert.equal(preflightPattern("rm -rf jev-local/rizzo-flow"), null)
assert.equal(preflightPattern("ls -la ~/Downloads"), null)
assert.equal(preflightPattern("du -sh ./node_modules"), null)

// reviewer regressions: split flags, quoted roots, quoted " / "
assert.equal(preflightPattern("rm -r -f /"), "rm-rf-unbounded")
assert.equal(preflightPattern('rm -rf "$HOME"'), "rm-rf-unbounded")
assert.equal(preflightPattern('grep -rn " / " ./logs'), null)
assert.equal(preflightPattern('git commit -m "fix: find / replace bug"'), null)
assert.equal(preflightPattern("npm run find-deps"), null)

// scanlike drives the timeout clamp only when no explicit timeout set (checked in hook)
assert.ok(SCANLIKE.test("grep -rn 'x' ./big-project"))
assert.ok(SCANLIKE.test("find ./tree -name '*.log'"))
assert.ok(!SCANLIKE.test("git status"))
assert.ok(!SCANLIKE.test("cat README.md"))

console.log("preflight: all assertions passed")
