import assert from "node:assert/strict"
import plugin from "../plugins/toolcall-guard.js"

const { preflightPattern, binaryPeek, janitorSweep, SCANLIKE } = plugin.__test

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


// --- binary-peek: unbounded reads of binary-extension files -----------------
// the live incident, verbatim shape
assert.equal(binaryPeek("cat ds4flash.gguf; echo; git log --oneline -3 -- ds4flash.gguf"), "binary-peek")
assert.equal(binaryPeek("cat model.bin"), "binary-peek")
assert.equal(binaryPeek("echo hi && cat weights.pt"), "binary-peek")
assert.equal(binaryPeek('cat "*.safetensors"'), "binary-peek")
assert.equal(binaryPeek("strings big.gguf"), "binary-peek")
// bounded forms are exempt
assert.equal(binaryPeek("cat ds4flash.gguf | head -3"), null)
assert.equal(binaryPeek("strings model.gguf | head -40"), null)
assert.equal(binaryPeek("xxd -l 64 x.gguf"), null)
assert.equal(binaryPeek("dd if=x.img count=4"), null)
assert.equal(binaryPeek("cat dump.bin > /tmp/out"), null)
assert.equal(binaryPeek("file ds4flash.gguf; head -c 64 ds4flash.gguf"), null)
assert.equal(binaryPeek("cat README.md"), null)

// --- janitor: >1GB AND >24h only --------------------------------------------
{
  const { mkdtempSync, writeFileSync, truncateSync, utimesSync, existsSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(tmpdir() + "/tcgj")
  writeFileSync(dir + "/small-old", "x")
  utimesSync(dir + "/small-old", new Date(Date.now() - 48e5 * 1000), new Date(Date.now() - 48e5 * 1000))
  writeFileSync(dir + "/huge-new", "")
  writeFileSync(dir + "/huge-old", "")
  truncateSync(dir + "/huge-new", 2e9)
  truncateSync(dir + "/huge-old", 2e9)
  utimesSync(dir + "/huge-old", new Date(Date.now() - 9e7), new Date(Date.now() - 9e7))
  const r = janitorSweep(dir)
  assert.equal(r.deleted, 1)
  assert.ok(!existsSync(dir + "/huge-old"))
  assert.ok(existsSync(dir + "/huge-new"))
  assert.ok(existsSync(dir + "/small-old"))
  assert.deepEqual(janitorSweep(dir + "/nope"), { deleted: 0, bytes: 0 })
}

console.log("preflight: all assertions passed")
